#!/usr/bin/env node
'use strict';
// pm-ask：执行 agent 主动呼叫 Notion 云端 PM（Custom Agent，Agent APIs 公测）。可选模块，见 references/cloud-pm.md。
//
// 用法:
//   node pm-ask.cjs blocked --dispatch "项目绝对路径/.dispatch/功能名" --task T03 --msg "卡在哪、试过什么"
//   node pm-ask.cjs merge   --dispatch "..." --task A02 [--base main] [--log "日志绝对路径"]
//   node pm-ask.cjs review  --dispatch "..." --task B04 --msg-file "说明文件绝对路径"
// 可选: --timeout 分钟（默认 15）
//
// 读取: 环境变量 NOTION_API_KEY（个人访问令牌）；<dispatch>/cloud-pm.json:
//   { "agent_id": "...", "project": "项目名", "project_page": "Notion 项目背景页链接" }
//   自动附带：卡片 cards/<卡号>*.md、results/<卡号>.md（若有）、ledger.md 中本卡那一行、只读 git 上下文。
// 写入: 只写 <dispatch>/work/<卡号>/pm-reply-<时间戳>.md 与 .json（在本卡白名单内）。
// 退出码: 0 拿到回复 / 1 接口或会话失败 / 2 用法或配置错误 / 3 PM 等待批准而当前不是交互终端

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const API = (process.env.NOTION_API_BASE || 'https://api.notion.com').replace(/\/$/, '') + '/v1';
const VERSION = '2026-03-11';
const POLL_MS = Number(process.env.PM_ASK_POLL_MS) || 4000;
const TYPES = { blocked: '卡住求助', merge: '申请合并/放行', review: '请 PM 拍板' };

function fail(code, msg) { console.error('[pm-ask] ' + msg); process.exit(code); }
const usage = (m) => fail(2, m + '\n用法: node pm-ask.cjs blocked|merge|review --dispatch 绝对路径 --task 卡号 [--msg 文本 | --msg-file 路径] [--log 路径] [--base 分支] [--timeout 分钟]');
const tail = (s, n) => (s && s.length > n ? '…（前文截断）\n' + s.slice(-n) : s || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const [type, ...rest] = argv;
  if (!TYPES[type]) usage(`第一个参数须是 ${Object.keys(TYPES).join(' / ')}`);
  const o = { type };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) usage(`无法识别的参数：${k}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${k} 缺少取值`);
    o[k.slice(2)] = v; i++;
  }
  if (!o.dispatch) usage('缺少 --dispatch');
  if (!o.task) usage('缺少 --task');
  if (!/^[A-Z]\d{2,}$/.test(o.task)) usage(`卡号格式不对：${o.task}（应形如 T03）`);
  return o;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function gitContext(cwd, base) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch) return null;
  let b = base;
  if (!b) b = ['main', 'master'].find((x) => git(['rev-parse', '--verify', '--quiet', x], cwd)) || '';
  const ctx = { branch, base: b || '（未找到 main/master）', head: git(['log', '-1', '--pretty=%h %s'], cwd), status: tail(git(['status', '--short'], cwd), 800) };
  if (b) {
    ctx.ahead = git(['rev-list', '--count', `${b}..HEAD`], cwd);
    ctx.behind = git(['rev-list', '--count', `HEAD..${b}`], cwd);
    ctx.stat = tail(git(['diff', '--stat', `${b}...HEAD`], cwd), 2500);
  }
  return ctx;
}

function readIf(p, n) { try { return tail(fs.readFileSync(p, 'utf8'), n); } catch { return ''; } }

function findCard(dir, task) {
  const cards = path.join(dir, 'cards');
  let names = [];
  try { names = fs.readdirSync(cards); } catch { return ''; }
  const hit = names.find((f) => f === `${task}.md` || f.startsWith(`${task}-`));
  return hit ? path.join(cards, hit) : '';
}

async function api(method, p, body) {
  const token = process.env.NOTION_API_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch(API + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt === 3) fail(1, `${method} ${p} 网络错误：${e.message}`);
      await sleep(1000 * (attempt + 1)); continue;
    }
    if ([429, 500, 503, 504, 529].includes(r.status) && attempt < 3) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 2000 * (attempt + 1)); continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) fail(1, `${method} ${p} -> ${r.status} ${j.code || ''} ${j.message || ''}`.trim());
    return j;
  }
}

async function askApproval(actions) {
  if (!process.stdin.isTTY) return null;
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const out = [];
  for (const a of actions) {
    const ans = await rl.question(`[pm-ask] PM 请求批准：${a.title}  批准？(y/N) `);
    out.push({ action_id: a.action_id, option_id: /^y/i.test(ans.trim()) ? 'approve' : 'reject' });
  }
  rl.close();
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = path.resolve(o.dispatch);
  if (!fs.existsSync(dir)) usage(`--dispatch 目录不存在：${dir}`);
  if (!process.env.NOTION_API_KEY) fail(2, '未设置环境变量 NOTION_API_KEY');
  const cfgPath = path.join(dir, 'cloud-pm.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { fail(2, `读不到或解析不了 ${cfgPath}`); }
  if (!cfg.agent_id) fail(2, `${cfgPath} 缺少 agent_id`);

  const feature = path.basename(dir);
  const cardPath = findCard(dir, o.task);
  const card = cardPath ? readIf(cardPath, 6000) : '';
  const result = o.type === 'blocked' ? '' : readIf(path.join(dir, 'results', `${o.task}.md`), 3000);
  const ledgerRow = (readIf(path.join(dir, 'ledger.md'), 200000).split('\n').find((l) => new RegExp(`^\\|\\s*${o.task}\\s*\\|`).test(l)) || '').trim();
  let note = o.msg || '';
  if (o['msg-file']) { note = readIf(path.resolve(o['msg-file']), 3000); if (!note) usage(`读不到 --msg-file：${o['msg-file']}`); }
  const log = o.log ? readIf(path.resolve(o.log), 3000) : '';
  const projectRoot = path.resolve(dir, '..', '..');
  const g = gitContext(projectRoot, o.base);

  const message = [
    `【${o.type}｜${TYPES[o.type]}】项目「${cfg.project || feature}」功能「${feature}」卡 ${o.task}`,
    ledgerRow && `台账行：${ledgerRow}`,
    g && `git：分支 ${g.branch}，基线 ${g.base}${g.ahead !== undefined ? `（领先 ${g.ahead} / 落后 ${g.behind}）` : ''}，最新 ${g.head}`,
    note && `执行 agent 说明：\n${note}`,
    g && g.stat && `改动统计：\n${g.stat}`,
    g && g.status && `工作树未提交：\n${g.status}`,
    log && `日志尾部：\n${log}`,
    result && `结果文件 results/${o.task}.md：\n${result}`,
    '请按指令页的输出契约回复，末尾附 JSON 决策块。',
  ].filter(Boolean).join('\n\n').slice(0, 10000);

  const promptContext = [
    cfg.project_page && `项目背景页：${cfg.project_page}`,
    card && `任务卡 ${path.basename(cardPath)}：\n${card}`,
  ].filter(Boolean).join('\n\n').slice(0, 10000);

  const s = await api('POST', '/sessions', {
    agent_id: cfg.agent_id,
    message,
    metadata: { type: o.type, task: o.task, feature, project: String(cfg.project || feature), branch: g ? g.branch : '' },
    ...(promptContext ? { prompt_context: promptContext } : {}),
  });
  console.error(`[pm-ask] 已呼叫云端 PM，session ${s.id}，等待回复…`);

  const deadline = Date.now() + (Number(o.timeout) || 15) * 60000;
  let cur = s;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    cur = await api('GET', `/sessions/${s.id}`);
    if (cur.status === 'requires_action') {
      const acts = await askApproval(cur.required_actions || []);
      if (!acts) fail(3, `PM 在等批准（${(cur.required_actions || []).map((a) => a.title).join('；')}），当前不是交互终端。请在 Notion 里打开该会话处理，session ${s.id}`);
      await api('POST', '/sessions', { session_id: s.id, actions: acts });
      continue;
    }
    if (!['queued', 'in_progress'].includes(cur.status)) break;
  }
  if (cur.status !== 'completed') fail(1, `会话未完成：${cur.status}${cur.error ? ' ' + cur.error.message : ''}（session ${s.id}）`);

  const msgs = [];
  let cursor = null;
  do {
    const r = await api('POST', `/sessions/${s.id}/events/query`, {
      filter: { property: 'type', event_type: { equals: 'agent.message' } },
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    msgs.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  msgs.sort((a, b) => a.sequence - b.sequence);
  const last = msgs[msgs.length - 1];
  const text = last ? (last.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') : '';
  if (!text) fail(1, `会话完成但没有 agent.message（session ${s.id}）`);
  console.log(text);

  const out = path.join(dir, 'work', o.task);
  fs.mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(out, `pm-reply-${stamp}.md`), `<!-- session ${s.id} -->\n${text}\n`);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) { console.error('[pm-ask] 回复里没有 JSON 决策块，原文已存 .md'); return; }
  try {
    const decision = JSON.parse(blocks[blocks.length - 1][1]);
    const jp = path.join(out, `pm-reply-${stamp}.json`);
    fs.writeFileSync(jp, JSON.stringify({ session: s.id, task: o.task, type: o.type, ...decision }, null, 2) + '\n');
    console.error(`[pm-ask] 决策 ${decision.decision || '（未写 decision）'}，已写入 ${jp}`);
  } catch { console.error('[pm-ask] JSON 决策块解析失败，原文已存 .md'); }
}

main().catch((e) => fail(1, e.stack || String(e)));

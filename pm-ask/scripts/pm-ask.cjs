#!/usr/bin/env node
'use strict';
// pm-ask v2.1：执行 agent 主动呼叫 Notion 云端 PM —— 直连方案（python 指纹通道）。
//
// 相对 v1（官方 Agent API）的变更:
//   * 请求通道: api.notion.com/v1（NOTION_API_KEY + agent_id）
//              → app.notion.com 私有接口直连: createAgentThread + listenToThreadTranscript，
//                走账号的个人 agent（本账号为「云端PM」）。
//   * 传输: Node 原生 fetch 的 TLS 指纹会被 Notion AI 端点拒绝
//           （400 UserValidationError / generic_error，2026-10 实机确认），
//           故 HTTP 调用经 python 子进程完成（scripts/pm-ask-turn.py + notion_direct.py，
//           curl_cffi Chrome 指纹）；本文件只负责证据组装、本地历史与文件读写。
//   * 凭据: NOTION_API_KEY(ntn_) → 环境变量 NOTION_TOKEN_V2（浏览器 Cookie 里的 token_v2）。
//   * 续聊: 服务端 session_id → 本地历史续接（pm-session.json 存 exchanges，摊平成
//     <conversation_history> 放进下一轮 prompt）。v1 的旧会话文件不迁移，自动新开。
//   * 退出码 3（PM 等批准）不再存在: 0 拿到回复 / 1 接口失败 / 2 用法或配置错误。
//   * cloud-pm.json 仅用 project / project_page；agent_id 不再使用。
//
// 用法:
//   node pm-ask.cjs blocked --dispatch "项目绝对路径/.dispatch/功能名" --task T03 --msg "卡在哪、试过什么"
//   node pm-ask.cjs merge   --dispatch "..." --task A02 [--base main] [--log "日志绝对路径"]
//   node pm-ask.cjs review  --dispatch "..." --task B04 --msg-file "说明文件绝对路径"
// 可选: --timeout 分钟（默认 15）；--new 强制新开会话
//
// 读取: 环境变量 NOTION_TOKEN_V2（必需）、NOTION_PM_MODEL（可选，默认 auto）、
//       PM_ASK_PYTHON（可选，默认 python，指向 python.exe）；
//       <dispatch>/cloud-pm.json: { "project": "项目名", "project_page": "Notion 项目背景页链接" }
//   自动附带：卡片 cards/<卡号>*.md、results/<卡号>.md（若有）、ledger.md 中本卡那一行、只读 git 上下文。
// 写入: 只写 <dispatch>/work/<卡号>/pm-reply-<时间戳>.md 与 .json、pm-session.json（在本卡白名单内）。
// 依赖: Node 内置 + python（PATH 中，3.10+）且已装 requests、curl_cffi。

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TYPES = { blocked: '卡住求助', merge: '申请合并/放行', review: '请 PM 拍板' };
const HISTORY_MAX_EXCHANGES = 2;
const HISTORY_ITEM_MAX = 8000;

function fail(code, msg) { console.error('[pm-ask] ' + msg); process.exit(code); }
const usage = (m) => fail(2, m + '\n用法: node pm-ask.cjs blocked|merge|review --dispatch 绝对路径 --task 卡号 [--msg 文本 | --msg-file 路径] [--log 路径] [--base 分支] [--timeout 分钟] [--new]');
const tail = (s, n) => (s && s.length > n ? '…（前文截断）\n' + s.slice(-n) : s || '');

function parseArgs(argv) {
  const [type, ...rest] = argv;
  if (!TYPES[type]) usage(`第一个参数须是 ${Object.keys(TYPES).join(' / ')}`);
  const o = { type };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) usage(`无法识别的参数：${k}`);
    if (k === '--new') { o.new = true; continue; }
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

// --- 直连层（python 子进程，curl_cffi Chrome 指纹） ---------------------------

// 把本地历史 + 本轮消息摊平成一条 agent 消息（与 notion_direct 的 _transcript_to_agent_prompt 同格式）
function buildPrompt(message, promptContext, exchanges) {
  const latest = [message, promptContext].filter(Boolean).join('\n\n').slice(0, 10000);
  if (!exchanges || !exchanges.length) return latest;
  const lines = ['<conversation_history>'];
  for (const ex of exchanges) {
    lines.push(`[User]\n${ex.user}\n`);
    lines.push(`[Assistant]\n${ex.assistant}\n`);
  }
  lines.push('</conversation_history>\n');
  lines.push('Continue the conversation above. Reply only to this latest user message:\n');
  lines.push(latest);
  return lines.join('\n');
}

function runTurnViaPython(prompt, deadlineMs) {
  return new Promise((resolve, reject) => {
    const helper = path.join(__dirname, 'pm-ask-turn.py');
    if (!fs.existsSync(helper)) {
      const e = new Error(`缺少内层助手 ${helper}`);
      e.configError = true;
      reject(e);
      return;
    }
    const py = process.env.PM_ASK_PYTHON || 'python';
    let child;
    try {
      child = spawn(py, [helper], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      e.configError = true;
      e.message = `无法启动 ${py}：${e.message}（可用 PM_ASK_PYTHON 指定 python.exe）`;
      reject(e);
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      finish(() => reject(new Error('等待 PM 回复超时（--timeout 可调）')));
    }, Math.max(1000, deadlineMs - Date.now()));
    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      e.configError = true;
      e.message = `python 启动失败：${e.message}（可用 PM_ASK_PYTHON 指定 python.exe）`;
      finish(() => reject(e));
    });
    child.on('close', (code) => finish(() => resolve({ code, out, err })));
    child.stdin.on('error', () => { /* 子进程先退出时忽略 EPIPE */ });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

// --- 主流程 ------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = path.resolve(o.dispatch);
  if (!fs.existsSync(dir)) usage(`--dispatch 目录不存在：${dir}`);
  const token = (process.env.NOTION_TOKEN_V2 || '').trim();
  if (!token) fail(2, '未设置环境变量 NOTION_TOKEN_V2（浏览器 Cookie 里的 token_v2）');
  const cfgPath = path.join(dir, 'cloud-pm.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { fail(2, `读不到或解析不了 ${cfgPath}`); }

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

  const out = path.join(dir, 'work', o.task);
  const sessFile = path.join(out, 'pm-session.json');
  let exchanges = [];
  if (!o.new) {
    try {
      const prev = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      if (Array.isArray(prev.exchanges)) exchanges = prev.exchanges;
      else console.error('[pm-ask] 检测到 v1 旧会话文件（官方 API 版），无法迁移，本轮按新会话处理');
    } catch { /* 无历史，新会话 */ }
  }

  const prompt = buildPrompt(message, promptContext, exchanges);
  const deadline = Date.now() + (Number(o.timeout) || 15) * 60000;
  console.error(`[pm-ask] 直连云端 PM（经 curl_cffi 指纹通道，${exchanges.length ? `续接 ${exchanges.length} 轮历史` : '新会话'}），等待回复…`);

  const turn = await runTurnViaPython(prompt, deadline).catch((e) => fail(e.configError ? 2 : 1, e.message));
  if (turn.code === 2) fail(2, (turn.err || '').trim() || '内层助手配置错误（退出码 2）');
  if (turn.code !== 0) fail(1, (turn.err || '').trim() || `内层助手异常退出（退出码 ${turn.code}）`);
  const text = turn.out;
  const tm = /thread_id=([0-9a-fA-F-]+)/.exec(turn.err || '');
  const threadId = tm ? tm[1] : '';
  console.log(text);

  fs.mkdirSync(out, { recursive: true });
  const saved = exchanges
    .concat([{ user: prompt.slice(-HISTORY_ITEM_MAX), assistant: text.slice(-HISTORY_ITEM_MAX) }])
    .slice(-HISTORY_MAX_EXCHANGES);
  fs.writeFileSync(sessFile, JSON.stringify({ thread_id: threadId, type: o.type, task: o.task, updated: new Date().toISOString(), exchanges: saved }, null, 2) + '\n');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(out, `pm-reply-${stamp}.md`), `<!-- thread ${threadId} -->\n${text}\n`);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) { console.error('[pm-ask] 回复里没有 JSON 决策块，原文已存 .md'); return; }
  try {
    const decision = JSON.parse(blocks[blocks.length - 1][1]);
    const jp = path.join(out, `pm-reply-${stamp}.json`);
    fs.writeFileSync(jp, JSON.stringify({ thread: threadId, task: o.task, type: o.type, ...decision }, null, 2) + '\n');
    console.error(`[pm-ask] 决策 ${decision.decision || '（未写 decision）'}，已写入 ${jp}`);
  } catch { console.error('[pm-ask] JSON 决策块解析失败，原文已存 .md'); }
}

if (require.main === module) main().catch((e) => fail(1, e.stack || String(e)));
module.exports = { buildPrompt, parseArgs };

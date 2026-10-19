#!/usr/bin/env node
'use strict';
// pm-ask v3（PM ↔ 子 agent 消息协议 v2）：执行 agent 主动呼叫 Notion 云端 PM —— 直连方案。
//
// 子命令（协议 v2 正式版）:
//   plan | check | ready | blocked | done | alert
//   merge  = ready 的别名
//   review = 过渡期别名：从 --msg/--msg-file 正文第一行的 #R-<类型> 推断类型
//
// 协议头由脚本用本地 git 生成（正文若自带 #R- 头会被丢弃并提示）:
//   #R-<TYPE> 卡=<卡号> 分支=<branch> HEAD=<40位SHA> 基线main=<7位SHA> 时间=<ISO8601>
//
// 回复: 终端打印 PM 文本；末尾 JSON 决策块落到 work/<卡号>/pm-reply-*.json（协议 3.1 形状）。
//   脚本用本地 git 比对 head_sha（允许 ≥7 位前缀）并写 head_sha_match；
//   旧版 tasks 数组回复按 {"tasks": [...]} 落盘并提示缺 directive。
// ready / check 前自动 git fetch origin main（PM_ASK_NO_FETCH=1 可关），消息里带「基线状态」一行。
// 用法:
//   node pm-ask.cjs plan    --dispatch "项目绝对路径/.dispatch/功能名" --task T03 --msg-file 计划.md
//   node pm-ask.cjs ready   --dispatch "..." --task T03 --msg-file 证据包.md        # merge 同义
//   node pm-ask.cjs blocked --dispatch "..." --task T03 --msg "卡在哪、试过什么"
// 可选: --timeout 分钟（默认 15）；--new 强制新开会话；--base 基线（默认 origin/main → main → master）
//
// 读取: 环境变量 NOTION_TOKEN_V2（必需）、NOTION_PM_MODEL（可选，默认 claude-sonnet5.5）、
//       PM_ASK_PYTHON（可选，默认 python，指向 python.exe）、PM_ASK_NO_FETCH（可选，=1 跳过 git fetch）；
//       <dispatch>/cloud-pm.json: { "project": "项目名", "project_page": "Notion 项目背景页链接" }
//   自动附带：卡片 cards/<卡号>*.md、results/<卡号>.md（BLOCKED 除外）、ledger.md 本卡那一行、
//   只读 git 上下文（分支/基线/领先落后/diff --stat/未提交）。
// 写入: 只写 <dispatch>/work/<卡号>/pm-reply-<时间戳>.md 与 .json、pm-session.json（在本卡白名单内）。
// 依赖: Node 内置 + python（PATH 中，3.10+）且已装 requests、curl_cffi。

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBCOMMANDS = ['plan', 'check', 'ready', 'blocked', 'done', 'alert', 'merge', 'review'];
const R_FOR = { plan: 'PLAN', check: 'CHECK', ready: 'READY', merge: 'READY', blocked: 'BLOCKED', done: 'DONE', alert: 'ALERT' };
const R_ALLOWED = new Set(['PLAN', 'CHECK', 'READY', 'BLOCKED', 'DONE', 'ALERT']);
const HISTORY_MAX_EXCHANGES = 2;
const HISTORY_ITEM_MAX = 8000;
const MESSAGE_MAX = 16000;

function fail(code, msg) { console.error('[pm-ask] ' + msg); process.exit(code); }
const usage = (m) => fail(2, m + '\n用法: node pm-ask.cjs plan|check|ready|blocked|done|alert|merge|review --dispatch 绝对路径 --task 卡号 [--msg 文本 | --msg-file 路径] [--log 路径] [--base 基线] [--timeout 分钟] [--new]');
const tail = (s, n) => (s && s.length > n ? '…（前文截断）\n' + s.slice(-n) : s || '');

function parseArgs(argv) {
  const [type, ...rest] = argv;
  if (!SUBCOMMANDS.includes(type)) usage(`第一个参数须是 ${SUBCOMMANDS.join(' / ')}`);
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

function resolveBase(cwd, explicit) {
  if (explicit) return explicit;
  for (const ref of ['origin/main', 'main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], cwd)) return ref;
  }
  return '';
}

function gitContext(cwd, base) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch) return null;
  const b = resolveBase(cwd, base);
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

// --- 协议 v2：上行类型与 #R 头 ------------------------------------------------

// 正文若自带 "#R-<类型> ..." 头，取其类型并剥离该行（头统一由脚本用本地 git 重生成）
function splitProtocolBody(note) {
  const trimmed = (note || '').replace(/^\uFEFF/, '').trim();
  const m = /^#R-([A-Z]+)\b[^\n]*(?:\n|$)/.exec(trimmed);
  if (m && R_ALLOWED.has(m[1])) {
    return { declared: m[1], body: trimmed.slice(m[0].length).trim() };
  }
  return { declared: null, body: trimmed };
}

// ready / check 前刷新 origin/main，避免基线读到过期值；返回给消息的「基线状态」一行
function refreshBaseline(rtype, cwd) {
  if (!['READY', 'CHECK'].includes(rtype)) return '';
  if (['1', 'true', 'yes'].includes(String(process.env.PM_ASK_NO_FETCH || '').toLowerCase())) {
    return '基线状态：未刷新（PM_ASK_NO_FETCH=1），origin/main 可能过时';
  }
  if (!git(['remote', 'get-url', 'origin'], cwd)) {
    return '基线状态：未刷新（无 origin 远端），基线取本地 main/master';
  }
  const r = spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], {
    cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status === 0) {
    const short = git(['rev-parse', '--short=7', 'origin/main'], cwd) || '?';
    return `基线状态：origin/main 已刷新（${short}）`;
  }
  const why = r.error && r.error.code === 'ETIMEDOUT' ? 'fetch 超时（15s）' : `fetch 退出码 ${r.status === null ? 'null' : r.status}`;
  return `基线状态：未刷新（${why}），origin/main 可能过时——按 #R 头里的基线自查`;
}

function buildProtocolHeader(rtype, task, cwd, base) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = git(['rev-parse', 'HEAD'], cwd);
  const baseRef = resolveBase(cwd, base);
  const baseShort = baseRef && git(['rev-parse', '--short=7', baseRef], cwd);
  if (!branch || !/^[0-9a-f]{40}$/.test(head) || !baseShort) {
    fail(2, '计算 #R 头失败：请在 git 仓库内运行，且存在 origin/main、main 或 master 基线（也可用 --base 指定）');
  }
  return `#R-${rtype} 卡=${task} 分支=${branch} HEAD=${head} 基线main=${baseShort} 时间=${new Date().toISOString()}`;
}

// --- 直连层（python 子进程，curl_cffi Chrome 指纹） ---------------------------

// 把本地历史 + 本轮消息摊平成一条 agent 消息（与 notion_direct 的 _transcript_to_agent_prompt 同格式）
function buildPrompt(message, promptContext, exchanges) {
  const latest = [message, promptContext].filter(Boolean).join('\n\n').slice(0, MESSAGE_MAX);
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
  const projectRoot = path.resolve(dir, '..', '..');
  const cardPath = findCard(dir, o.task);
  const card = cardPath ? readIf(cardPath, 6000) : '';
  const ledgerRow = (readIf(path.join(dir, 'ledger.md'), 200000).split('\n').find((l) => new RegExp(`^\\|\\s*${o.task}\\s*\\|`).test(l)) || '').trim();
  let rawNote = o.msg || '';
  if (o['msg-file']) { rawNote = readIf(path.resolve(o['msg-file']), MESSAGE_MAX); if (!rawNote) usage(`读不到 --msg-file：${o['msg-file']}`); }
  const log = o.log ? readIf(path.resolve(o.log), 3000) : '';

  // 协议类型：正式子命令直接映射；review 从正文 #R-<类型> 推断
  const { declared, body } = splitProtocolBody(rawNote);
  let rtype = R_FOR[o.type] || null;
  if (o.type === 'review') {
    if (!declared) usage('review 是过渡期别名：正文第一行必须写 #R-<PLAN|CHECK|READY|BLOCKED|DONE|ALERT>，或改用正式子命令 plan|check|ready|blocked|done|alert');
    rtype = declared;
    console.error(`[pm-ask] review → #R-${rtype}（过渡期别名）`);
  } else if (declared && declared !== rtype) {
    console.error(`[pm-ask] 正文声明的 #R-${declared} 与子命令 ${o.type} 不一致，以子命令为准（#R-${rtype}）`);
  }
  if (declared) console.error('[pm-ask] 已丢弃正文自带的 #R 头，改用本地 git 实测值重生成');

  const result = rtype === 'BLOCKED' ? '' : readIf(path.join(dir, 'results', `${o.task}.md`), 3000);
  const baselineNote = refreshBaseline(rtype, projectRoot);
  const g = gitContext(projectRoot, o.base);
  const rhead = buildProtocolHeader(rtype, o.task, projectRoot, o.base);

  const message = [
    rhead,
    body || '',
    ledgerRow && `台账行：${ledgerRow}`,
    baselineNote && baselineNote,
    g && `git：分支 ${g.branch}，基线 ${g.base}${g.ahead !== undefined ? `（领先 ${g.ahead} / 落后 ${g.behind}）` : ''}，最新 ${g.head}`,
    g && g.stat && `改动统计：\n${g.stat}`,
    g && g.status && `工作树未提交：\n${g.status}`,
    log && `日志尾部：\n${log}`,
    result && `结果文件 results/${o.task}.md：\n${result}`,
    '请按协议 v2 回复：文本头 + 说明，末尾附一个 JSON 决策块（decision / directive / head_sha / actions / report / tasks）；脚本以该 JSON 块为准。',
  ].filter(Boolean).join('\n\n').slice(0, MESSAGE_MAX);

  const promptContext = [
    cfg.project_page && `项目背景页：${cfg.project_page}`,
    card && `任务卡 ${path.basename(cardPath)}：\n${card}`,
  ].filter(Boolean).join('\n\n').slice(0, MESSAGE_MAX);

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
  console.error(`[pm-ask] ${rhead.split(' ')[0]} 直连云端 PM（经 curl_cffi 指纹通道，${exchanges.length ? `续接 ${exchanges.length} 轮历史` : '新会话'}），等待回复…`);

  const turn = await runTurnViaPython(prompt, deadline).catch((e) => fail(e.configError ? 2 : 1, e.message));
  if (turn.code === 2) fail(2, (turn.err || '').trim() || '内层助手配置错误（退出码 2）');
  if (turn.code !== 0) fail(1, (turn.err || '').trim() || `内层助手异常退出（退出码 ${turn.code}）`);
  const text = turn.out;
  const tm = /thread_id=([0-9a-fA-F-]+)/.exec(turn.err || '');
  const threadId = tm ? tm[1] : '';
  console.log(text);

  fs.mkdirSync(out, { recursive: true });
  // 历史只存本轮 message（不存整个 prompt，避免历史包裹嵌套并把 #R 头挤掉）
  const saved = exchanges
    .concat([{ user: message.slice(-HISTORY_ITEM_MAX), assistant: text.slice(-HISTORY_ITEM_MAX) }])
    .slice(-HISTORY_MAX_EXCHANGES);
  fs.writeFileSync(sessFile, JSON.stringify({ thread_id: threadId, type: o.type, r_type: rtype, task: o.task, updated: new Date().toISOString(), exchanges: saved }, null, 2) + '\n');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(out, `pm-reply-${stamp}.md`), `<!-- thread ${threadId} -->\n${text}\n`);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) { console.error('[pm-ask] 回复里没有 JSON 决策块，原文已存 .md'); return; }
  try {
    let decision = JSON.parse(blocks[blocks.length - 1][1]);
    if (Array.isArray(decision)) {
      decision = { tasks: decision };
      console.error('[pm-ask] 回复末尾是旧版 tasks 数组，已按 {"tasks": [...]} 落盘；缺 directive——不要执行任何 actions');
    } else if (decision === null || typeof decision !== 'object') {
      decision = {};
      console.error('[pm-ask] 回复末尾的 JSON 不是对象，已忽略；缺 directive——不要执行任何 actions');
    } else if (!decision.directive) {
      console.error('[pm-ask] 回复缺 directive——不要执行任何 actions，按文本说明或等 PM 对象格式');
    }

    // head_sha 校验：允许 ≥7 位前缀（PM 可能只给短 SHA），结果写进 json 供 agent 判断
    const localHead = git(['rev-parse', 'HEAD'], projectRoot);
    let headShaMatch = null;
    const want = String(decision.head_sha || '').trim().toLowerCase();
    if (want) {
      const ok = want.length >= 7 && localHead && (localHead.startsWith(want) || want.startsWith(localHead));
      headShaMatch = !!ok;
      if (!ok) {
        console.error(
          `[pm-ask] !! head_sha 与本地 HEAD 不吻合：授权 ${want.slice(0, 12)}…，当前 ${(localHead || '(非 git)').slice(0, 12)}… —— 不要执行任何 actions，按 #R-BLOCKED 回报`
        );
      }
    }

    const jp = path.join(out, `pm-reply-${stamp}.json`);
    fs.writeFileSync(jp, JSON.stringify({ thread: threadId, task: o.task, type: o.type, r_type: rtype, ...decision, head_sha_match: headShaMatch }, null, 2) + '\n');
    const acts = Array.isArray(decision.actions) ? decision.actions.map((a) => a && a.do).filter(Boolean) : [];
    console.error(
      `[pm-ask] 决策 decision=${decision.decision || '?'} directive=${decision.directive || '?'} ` +
      `head_sha=${want ? want.slice(0, 7) : '(空)'} match=${headShaMatch === null ? 'n/a' : headShaMatch} ` +
      `report=${decision.report || '?'} actions=${acts.length ? acts.join(',') : '无'}，已写入 ${jp}`
    );
  } catch { console.error('[pm-ask] JSON 决策块解析失败，原文已存 .md'); }
}

if (require.main === module) main().catch((e) => fail(1, e.stack || String(e)));
module.exports = { buildPrompt, parseArgs, splitProtocolBody };

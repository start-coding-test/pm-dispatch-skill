#!/usr/bin/env node
'use strict';
// pm-ask.cjs 的离线自测：桩替身 pm-ask-turn.py 顶替直连网络，验证协议 v2 的
// #R 头、子命令映射、head_sha 校验、旧格式兼容、基线刷新、card/thread 行、
// 默认「上轮结论摘要」与 --full-history、按卡续聊与落盘。
// 需要本机有 git（算 #R 头 / head_sha / fetch）与 python（跑内层助手）；缺任一则跳过对应部分。
// 用法: node tests/pm-ask.test.cjs      退出码 0 = 全过

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'pm-ask', 'scripts', 'pm-ask.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pm ask selftest '));
const SKILL = path.join(ROOT, 'skill'); // 复刻技能脚本结构：pm-ask.cjs + 桩替身
const D = path.join(ROOT, '.dispatch', 'demo');
const LOG = path.join(ROOT, 'prompt.log');
const PY = process.env.PM_ASK_PYTHON || 'python';
const STUB_THREAD = '11111111-2222-3333-4444-555555555555';
let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${name}${detail ? '\n     | ' + String(detail).split('\n').join('\n     | ') : ''}`); }
}
const skipped = (name) => { skip++; console.log(`SKIP ${name}`); };
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const clearLog = () => { fs.rmSync(LOG, { force: true }); };
const sessFile = (t) => path.join(D, 'work', t, 'pm-session.json');
const latestReplyJson = (t) => {
  const w = path.join(D, 'work', t);
  const f = fs.readdirSync(w).filter((x) => x.startsWith('pm-reply-') && x.endsWith('.json')).sort().pop();
  return f ? JSON.parse(fs.readFileSync(path.join(w, f), 'utf8')) : {};
};
const HEADER_RE = /^#R-([A-Z]+) 卡=(\S+) 分支=(\S+) HEAD=([0-9a-f]{40}) 基线main=([0-9a-f]{7}) 时间=\S+/;
// --full-history 时 prompt 以 <conversation_history> 开头；取「本轮」那一段再匹配 #R 头
const latestOf = (log) => {
  const marker = 'Reply only to this latest user message:';
  const i = log.lastIndexOf(marker);
  return (i < 0 ? log : log.slice(i + marker.length)).replace(/^\s+/, '');
};
const headerOf = (log) => HEADER_RE.exec(latestOf(log));

// ---------- 桩替身：读 stdin（prompt）落盘 → 按 STUB_MODE 回应 ----------
// 「第 N 轮」由 prompt 里有没有历史包裹或「上轮 PM 结论」摘要决定；STUB_HEAD_SHA 注入 head_sha；
// STUB_MODE=array 模拟旧版 tasks 数组回复。
const STUB = `# -*- coding: utf-8 -*-
import os, sys
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
prompt = sys.stdin.read()
log = os.environ.get("STUB_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(prompt + "\\n=====PROMPT-END=====\\n")
mode = os.environ.get("STUB_MODE", "ok")
if mode == "exit2":
    print("[pm-ask-turn] 桩替身：模拟配置错误", file=sys.stderr)
    sys.exit(2)
if mode == "exit1":
    print("[pm-ask-turn] 上游错误: HTTP 401 UserValidationError", file=sys.stderr)
    sys.exit(1)
n = 2 if ("<conversation_history>" in prompt or "上轮 PM 结论" in prompt) else 1
sha = os.environ.get("STUB_HEAD_SHA", "")
if mode == "array":
    payload = '[{"id":"A05","goal":"stub"}]'
else:
    payload = '{"decision":"fix","directive":"FIX","head_sha":"%s","actions":[{"do":"run_gates","cmds":["npm test"]}],"report":"R-CHECK","tasks":[],"reason":"第%d轮"}' % (sha, n)
print("[pm-ask-turn] thread_id=${STUB_THREAD} hist=%s len=%d" % (n == 2, len(prompt)), file=sys.stderr)
print('第%d轮建议：先修 schema 再重跑。\\n\\n\`\`\`json\\n%s\\n\`\`\`' % (n, payload))
`;

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(SKILL, 'pm-ask.cjs'), ...args], {
      env: { ...process.env, NOTION_TOKEN_V2: 'test-token', STUB_LOG: LOG, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (rc) => resolve({ rc, out }));
  });
}

(async () => {
  fs.mkdirSync(SKILL, { recursive: true });
  fs.copyFileSync(SRC, path.join(SKILL, 'pm-ask.cjs'));
  fs.writeFileSync(path.join(SKILL, 'pm-ask-turn.py'), STUB);
  fs.mkdirSync(path.join(D, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(D, 'results'), { recursive: true });
  fs.writeFileSync(path.join(D, 'cards', 'T03-schema.md'), '# T03 schema 单测\n卡片正文');
  fs.writeFileSync(path.join(D, 'results', 'T03.md'), '# T03 执行结果\n**状态**: DONE');
  fs.writeFileSync(path.join(D, 'ledger.md'), '| 卡 | 标题 |\n|----|----|\n| T03 | schema 单测 | 无 | 执行中 | |\n| T30 | 别的卡 | 无 | 待派 | |\n');
  const base = ['--dispatch', D, '--task', 'T03'];

  // ---------- 参数与配置（不依赖 git / python） ----------
  let r = await run(['nope', ...base]);
  check('未知子命令 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D]);
  check('缺 --task → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D, '--task', 't3']);
  check('卡号格式不对 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', ...base]);
  check('缺 cloud-pm.json → 退出码 2', r.rc === 2 && /cloud-pm\.json/.test(r.out), r.out);

  fs.writeFileSync(path.join(D, 'cloud-pm.json'), JSON.stringify({ project: '演示', project_page: 'https://www.notion.so/demo' }));
  r = await run(['blocked', ...base, '--msg', 'x'], { NOTION_TOKEN_V2: '' });
  check('缺令牌 → 退出码 2', r.rc === 2 && /NOTION_TOKEN_V2/.test(r.out), r.out);

  // ---------- 夹具 git 仓库（#R 头 / head_sha / fetch 需要） ----------
  const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasGit) {
    const g = (args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(ROOT, 'repo.txt'), 'fixture\n');
    g(['add', 'repo.txt']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    g(['remote', 'add', 'origin', ROOT]); // 以自身当远端，供 ready/check 的 fetch 用
    g(['fetch', '-q', 'origin', 'main']);
    r = await run(['blocked', ...base, '--msg', 'x'], { PM_ASK_PYTHON: 'definitely_not_exist_cmd' });
    check('python 不存在 → 退出码 2 且报启动失败', r.rc === 2 && /python 启动失败/.test(r.out), r.out);
  } else {
    skipped('git 相关（本机没有 git）');
  }

  const hasPython = spawnSync(PY, ['-c', 'pass'], { stdio: 'ignore' }).status === 0;
  if (!hasGit || !hasPython) {
    for (const name of ['首次呼叫', '默认摘要', '--full-history', '--new 重置', '跨卡隔离', '子命令映射', 'review 过渡', 'head_sha 校验', '旧格式兼容', '基线刷新', '助手失败路径']) {
      skipped(name + '（缺 ' + (!hasGit ? 'git' : 'python') + '）');
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`pm-ask 自测：${pass} 过，${fail} 挂，${skip} 跳过`);
    process.exit(fail ? 1 : 0);
  }

  // ---------- 首次呼叫（merge = ready 别名）：协议头、fetch、card/thread 行与证据 ----------
  clearLog();
  r = await run(['merge', ...base, '--msg', '自测全绿']);
  check('首次呼叫 → 退出码 0', r.rc === 0, r.out);
  check('打印第1轮回复', r.out.includes('第1轮建议'), r.out);
  let log = readLog();
  const h1 = headerOf(log);
  check('首行是协议头 #R-READY', !!h1 && h1[1] === 'READY' && h1[2] === 'T03' && h1[3] === 'main', log.slice(0, 160));
  check('协议头下一行是 card/thread（首轮 thread=none）', log.includes('card=T03-schema.md thread=none'), log.slice(0, 240));
  check('正文在 card/thread 行之后', log.indexOf('自测全绿') > log.indexOf('card=T03-schema.md'));
  check('ready 前自动 fetch：基线状态已刷新', log.includes('基线状态：origin/main 已刷新'), log.slice(0, 400));
  check('带本卡台账行且不串 T30', log.includes('| T03 | schema 单测') && !log.includes('T30'));
  check('ready 附结果文件', log.includes('**状态**: DONE'));
  check('不附带卡片正文与背景页（PM 从 Notion 读）', !log.includes('卡片正文') && !log.includes('notion.so/demo'));
  check('首次呼叫不带历史包裹与上轮摘要', !log.includes('<conversation_history>') && !log.includes('上轮 PM 结论'));
  check('单条 prompt 不超过 32000 字符', log.length < 32000, String(log.length));
  const work = path.join(D, 'work', 'T03');
  const files = fs.readdirSync(work);
  const jf = files.find((f) => f.startsWith('pm-reply-') && f.endsWith('.json'));
  check('只写在 work/T03 下：md+json 各一份', files.filter((f) => f.endsWith('.md')).length === 1 && !!jf, files.join(','));
  const dec = jf ? JSON.parse(fs.readFileSync(path.join(work, jf), 'utf8')) : {};
  check('决策块：decision/directive/actions 解析正确',
    dec.decision === 'fix' && dec.directive === 'FIX' && dec.r_type === 'READY' &&
    Array.isArray(dec.actions) && dec.actions[0].do === 'run_gates' && dec.task === 'T03' && dec.thread === STUB_THREAD,
    JSON.stringify(dec));
  check('未给 head_sha → head_sha_match=null', dec.head_sha_match === null && /match=n\/a/.test(r.out), r.out);
  check('终端打印决策摘要含 directive/actions', /directive=FIX/.test(r.out) && /actions=run_gates/.test(r.out), r.out);
  const sess1 = JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8'));
  check('会话文件存 thread_id、#R 类型、last 摘要与 1 轮历史',
    sess1.thread_id === STUB_THREAD && sess1.r_type === 'READY' && sess1.exchanges.length === 1 &&
    sess1.last && sess1.last.directive === 'FIX' && sess1.last.thread_id === STUB_THREAD,
    JSON.stringify(sess1).slice(0, 400));

  // ---------- 同一张卡第二次：默认只带本轮消息 + 上轮结论摘要 ----------
  clearLog();
  r = await run(['blocked', ...base, '--msg', '现象：照做后仍红']);
  check('第二次呼叫 → 退出码 0 且打印第2轮回复', r.rc === 0 && r.out.includes('第2轮建议') && !r.out.includes('第1轮建议'), r.out);
  log = readLog();
  check('blocked 本轮首行为 #R-BLOCKED', /^#R-BLOCKED 卡=T03 /.test(latestOf(log)), latestOf(log).slice(0, 120));
  check('默认不带历史包裹，改带上一轮结论摘要', !log.includes('<conversation_history>') && log.includes('上轮 PM 结论') && log.includes('directive=FIX'));
  check('消息头 thread 指向上一轮线程', log.includes(`card=T03-schema.md thread=${STUB_THREAD}`));
  check('默认 prompt 不随历史膨胀（<8000 字符）', latestOf(log).length < 8000, String(latestOf(log).length));
  const latest2 = log.split('Reply only to this latest user message:').pop() || '';
  check('blocked 本轮不附结果文件', latest2 && !latest2.includes('**状态**: DONE'), latest2.slice(0, 200));
  const sess2 = JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8'));
  check('历史累计到 2 轮（供 --full-history）', sess2.exchanges.length === 2, String(sess2.exchanges.length));

  // ---------- --full-history：重放全量历史 ----------
  clearLog();
  r = await run(['check', ...base, '--msg', '全量历史测试', '--full-history']);
  log = readLog();
  check('--full-history：重放多轮历史包裹', r.rc === 0 && log.includes('<conversation_history>') && log.includes('第1轮建议') && log.includes('第2轮建议'), log.slice(0, 300));
  check('--full-history：进程提示全量历史', /全量历史 2 轮/.test(r.out), r.out);

  // ---------- --new：历史与摘要重置 ----------
  clearLog();
  r = await run(['check', ...base, '--msg', '完成：x', '--new']);
  check('--new → 第1轮回复（旧历史不带入）', r.rc === 0 && r.out.includes('第1轮建议'), r.out);
  check('--new 的 prompt 不带历史包裹', !readLog().includes('<conversation_history>'));
  check('--new 不带上轮结论摘要', !readLog().includes('上轮 PM 结论'));
  check('--new 后 thread=none', readLog().includes('thread=none'));
  check('--new 后历史重置为 1 轮', JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8')).exchanges.length === 1);

  // ---------- 另一张卡：各用各的会话 ----------
  clearLog();
  r = await run(['blocked', '--dispatch', D, '--task', 'T04', '--msg', 'x']);
  check('另一张卡 → 独立会话且为第1轮', r.rc === 0 && r.out.includes('第1轮建议') && fs.existsSync(sessFile('T04')), r.out);
  check('不串卡：T04 prompt 无 T03 卡片正文', !readLog().includes('卡片正文'));

  // ---------- 子命令映射：每种都能生成对应的 #R 头 ----------
  for (const [sub, R] of [['plan', 'PLAN'], ['check', 'CHECK'], ['ready', 'READY'], ['done', 'DONE'], ['alert', 'ALERT']]) {
    clearLog();
    r = await run([sub, ...base, '--msg', '模板正文']);
    const h = headerOf(readLog());
    check(`${sub} → #R-${R} 且退出码 0`, r.rc === 0 && !!h && h[1] === R && h[2] === 'T03', r.out);
  }

  // ---------- review 过渡别名：类型取自正文，头由本地 git 重生成 ----------
  clearLog();
  r = await run(['review', ...base, '--msg', '#R-CHECK 卡=T03 分支=stale HEAD=deadbeef 基线main=1234567 时间=old\n完成：x']);
  log = readLog();
  const hRev = headerOf(log);
  check('review + 正文 #R-CHECK → 生成 #R-CHECK 头', r.rc === 0 && !!hRev && hRev[1] === 'CHECK', r.out);
  check('旧头被丢弃：本轮只剩一个 #R-CHECK、分支为实测 main', (latestOf(log).match(/#R-CHECK/g) || []).length === 1 && hRev && hRev[3] === 'main', latestOf(log).slice(0, 160));
  check('review 正文保留', log.includes('完成：x'));
  r = await run(['review', ...base, '--msg', '没有类型行']);
  check('review 缺 #R 类型 → 退出码 2 并提示', r.rc === 2 && /正文第一行必须写 #R-/.test(r.out), r.out);
  clearLog();
  r = await run(['plan', ...base, '--msg', '#R-CHECK 卡=T03 分支=x HEAD=y 基线main=z 时间=t\n计划正文']);
  const hMis = headerOf(readLog());
  check('子命令与正文类型不一致 → 以子命令为准并警告', r.rc === 0 && !!hMis && hMis[1] === 'PLAN' && /不一致/.test(r.out), r.out);

  // ---------- head_sha 校验（≥7 位前缀）、摘要回带与旧格式兼容 ----------
  const localShort = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  clearLog();
  r = await run(['ready', ...base, '--msg', 'x'], { STUB_HEAD_SHA: localShort });
  let cur = latestReplyJson('T03');
  check('head_sha 用 7 位前缀吻合 → head_sha_match=true', r.rc === 0 && cur.head_sha_match === true && /match=true/.test(r.out), r.out);

  clearLog();
  r = await run(['ready', ...base, '--msg', 'x'], { STUB_HEAD_SHA: 'deadbeef' });
  cur = latestReplyJson('T03');
  check('head_sha 不吻合 → head_sha_match=false 且醒目警告', r.rc === 0 && cur.head_sha_match === false && /不吻合/.test(r.out) && /不要执行任何 actions/.test(r.out), r.out);
  check('上轮结论摘要回带上轮 head_sha', readLog().includes(`head_sha=${localShort}`), readLog().slice(0, 400));

  clearLog();
  r = await run(['check', ...base, '--msg', 'x'], { STUB_MODE: 'array' });
  cur = latestReplyJson('T03');
  check('数组型回复 → 按 {tasks} 落盘、无 directive、head_sha_match=null',
    r.rc === 0 && Array.isArray(cur.tasks) && cur.directive === undefined && cur.head_sha_match === null &&
    /旧版 tasks 数组/.test(r.out) && /缺 directive/.test(r.out), r.out);

  clearLog();
  r = await run(['ready', ...base, '--msg', 'x'], { PM_ASK_NO_FETCH: '1' });
  check('PM_ASK_NO_FETCH=1 → 基线状态标注未刷新', r.rc === 0 && readLog().includes('未刷新（PM_ASK_NO_FETCH=1）'), readLog().slice(0, 300));

  // ---------- 内层助手失败路径 ----------
  r = await run(['blocked', ...base, '--msg', 'x'], { STUB_MODE: 'exit1' });
  check('助手退出 1 → 脚本退出 1 并原样带错误', r.rc === 1 && /上游错误/.test(r.out), r.out);
  r = await run(['blocked', ...base, '--msg', 'x'], { STUB_MODE: 'exit2' });
  check('助手退出 2 → 脚本退出 2', r.rc === 2 && /桩替身：模拟配置错误/.test(r.out), r.out);

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`pm-ask 自测：${pass} 过，${fail} 挂${skip ? '，' + skip + ' 跳过' : ''}`);
  process.exit(fail ? 1 : 0);
})();

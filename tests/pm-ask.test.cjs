#!/usr/bin/env node
'use strict';
// pm-ask.cjs 的离线自测：在临时技能目录里放一个「桩替身」pm-ask-turn.py 顶替直连网络，
// 逐项断言退出码、证据组装、按卡续聊与落盘。需要本机有 python（没有则跳过桩替身部分）。
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

// ---------- 桩替身：读 stdin（prompt）落盘 → 按 STUB_MODE 回应 ----------
// 「第 N 轮」由 prompt 里有没有 <conversation_history> 决定，用来断言续聊真的注入了历史。
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
n = 2 if "<conversation_history>" in prompt else 1
print("[pm-ask-turn] thread_id=${STUB_THREAD} hist=%s len=%d" % (n == 2, len(prompt)), file=sys.stderr)
print('第%d轮建议：先修 schema 再重跑。\\n\\n\`\`\`json\\n{"decision":"fix","reason":"第%d轮","tasks":[]}\\n\`\`\`' % (n, n))
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

  // ---------- 参数与配置（不依赖 python） ----------
  let r = await run(['nope', ...base]);
  check('未知类型 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D]);
  check('缺 --task → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D, '--task', 't3']);
  check('卡号格式不对 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', ...base]);
  check('缺 cloud-pm.json → 退出码 2', r.rc === 2 && /cloud-pm\.json/.test(r.out), r.out);

  fs.writeFileSync(path.join(D, 'cloud-pm.json'), JSON.stringify({ project: '演示', project_page: 'https://www.notion.so/demo' }));
  r = await run(['blocked', ...base, '--msg', 'x'], { NOTION_TOKEN_V2: '' });
  check('缺令牌 → 退出码 2', r.rc === 2 && /NOTION_TOKEN_V2/.test(r.out), r.out);
  r = await run(['blocked', ...base, '--msg', 'x'], { PM_ASK_PYTHON: 'definitely_not_exist_cmd' });
  check('python 不存在 → 退出码 2 且报启动失败', r.rc === 2 && /python 启动失败/.test(r.out), r.out);

  const hasPython = spawnSync(PY, ['-c', 'pass'], { stdio: 'ignore' }).status === 0;
  if (!hasPython) {
    for (const name of ['首次呼叫', '按卡续聊', '--new 重置', '跨卡隔离', '助手失败路径']) skipped(name + '（本机没有 python）');
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`pm-ask 自测：${pass} 过，${fail} 挂，${skip} 跳过`);
    process.exit(fail ? 1 : 0);
  }

  // ---------- 首次呼叫（merge）：证据组装与落盘 ----------
  clearLog();
  r = await run(['merge', ...base, '--msg', '自测全绿']);
  check('首次呼叫 → 退出码 0', r.rc === 0, r.out);
  check('打印第1轮回复', r.out.includes('第1轮建议'), r.out);
  let log = readLog();
  check('消息头为【merge｜申请合并/放行】', log.includes('【merge｜申请合并/放行】'), log.slice(0, 200));
  check('带本卡台账行且不串 T30', log.includes('| T03 | schema 单测') && !log.includes('T30'));
  check('merge 附结果文件', log.includes('**状态**: DONE'));
  check('卡片与背景页随附', log.includes('卡片正文') && log.includes('notion.so/demo'));
  check('首次呼叫不带历史包裹', !log.includes('<conversation_history>'));
  check('单条 prompt 不超过 25000 字符', log.length < 25000, String(log.length));
  const work = path.join(D, 'work', 'T03');
  const files = fs.readdirSync(work);
  const jf = files.find((f) => f.startsWith('pm-reply-') && f.endsWith('.json'));
  check('只写在 work/T03 下：md+json 各一份', files.filter((f) => f.endsWith('.md')).length === 1 && !!jf, files.join(','));
  const dec = jf ? JSON.parse(fs.readFileSync(path.join(work, jf), 'utf8')) : {};
  check('JSON 决策块解析正确', dec.decision === 'fix' && dec.thread === STUB_THREAD && dec.task === 'T03', JSON.stringify(dec));
  const sess1 = JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8'));
  check('会话文件存 thread_id 与 1 轮历史', sess1.thread_id === STUB_THREAD && sess1.exchanges.length === 1, JSON.stringify(sess1).slice(0, 300));

  // ---------- 同一张卡第二次：本地历史续聊 ----------
  clearLog();
  r = await run(['blocked', ...base, '--msg', '照做后仍红']);
  check('第二次呼叫 → 退出码 0 且打印第2轮回复', r.rc === 0 && r.out.includes('第2轮建议') && !r.out.includes('第1轮建议'), r.out);
  log = readLog();
  check('续聊：历史包裹注入且含上轮回复', log.includes('<conversation_history>') && log.includes('第1轮建议'));
  const latest2 = log.split('Reply only to this latest user message:').pop() || '';
  check('blocked 本轮不附结果文件（历史里保留上轮属预期）', latest2 && !latest2.includes('**状态**: DONE'), latest2.slice(0, 200));
  const sess2 = JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8'));
  check('历史累计到 2 轮', sess2.exchanges.length === 2, String(sess2.exchanges.length));

  // ---------- --new：历史重置 ----------
  clearLog();
  r = await run(['review', ...base, '--msg', 'x', '--new']);
  check('--new → 第1轮回复（旧历史不带入）', r.rc === 0 && r.out.includes('第1轮建议'), r.out);
  check('--new 的 prompt 不带历史', !readLog().includes('<conversation_history>'));
  check('--new 后历史重置为 1 轮', JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8')).exchanges.length === 1);

  // ---------- 另一张卡：各用各的会话 ----------
  clearLog();
  r = await run(['blocked', '--dispatch', D, '--task', 'T04', '--msg', 'x']);
  check('另一张卡 → 独立会话且为第1轮', r.rc === 0 && r.out.includes('第1轮建议') && fs.existsSync(sessFile('T04')), r.out);
  check('不串卡：T04 prompt 无 T03 卡片正文', !readLog().includes('卡片正文'));

  // ---------- 内层助手失败路径 ----------
  r = await run(['blocked', ...base, '--msg', 'x'], { STUB_MODE: 'exit1' });
  check('助手退出 1 → 脚本退出 1 并原样带错误', r.rc === 1 && /上游错误/.test(r.out), r.out);
  r = await run(['blocked', ...base, '--msg', 'x'], { STUB_MODE: 'exit2' });
  check('助手退出 2 → 脚本退出 2', r.rc === 2 && /桩替身：模拟配置错误/.test(r.out), r.out);

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`pm-ask 自测：${pass} 过，${fail} 挂${skip ? '，' + skip + ' 跳过' : ''}`);
  process.exit(fail ? 1 : 0);
})();

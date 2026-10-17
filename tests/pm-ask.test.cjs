#!/usr/bin/env node
'use strict';
// pm-ask.cjs 的离线自测：本地起一个假的 Notion Sessions API，不需要真实令牌与网络。
// 用法: node tests/pm-ask.test.cjs      退出码 0 = 全过

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'pm-ask', 'scripts', 'pm-ask.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pm ask selftest '));
const D = path.join(ROOT, '.dispatch', 'demo');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${name}${detail ? '\n     | ' + String(detail).split('\n').join('\n     | ') : ''}`); }
}

// ---------- 假 API ----------
let scenario = 'ok';
const seen = [];
let polls = 0;
const REPLY = '建议：先修 schema 再重跑。\n```json\n{"decision":"fix","reason":"字段缺失","tasks":[]}\n```';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: j });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { code: 'unauthorized', message: 'bad token' });
    if (req.method === 'POST' && req.url === '/v1/sessions') return send(200, { object: 'session', id: 'sess-1', status: 'queued' });
    if (req.method === 'GET' && req.url === '/v1/sessions/sess-1') {
      polls++;
      if (scenario === 'action') return send(200, { id: 'sess-1', status: 'requires_action', required_actions: [{ action_id: 'a1', title: '合并 PR', options: [] }] });
      if (scenario === 'failed') return send(200, { id: 'sess-1', status: 'failed', error: { code: 'x', message: '额度用完', retryable: false } });
      return send(200, { id: 'sess-1', status: polls < 2 ? 'in_progress' : 'completed' });
    }
    if (req.method === 'POST' && req.url === '/v1/sessions/sess-1/events/query') {
      return send(200, { results: [
        { sequence: 5, type: 'agent.message', content: [{ type: 'text', text: '旧消息' }] },
        { sequence: 9, type: 'agent.message', content: [{ type: 'text', text: REPLY }] },
      ], has_more: false, next_cursor: null });
    }
    send(404, { code: 'object_not_found', message: req.url });
  });
});

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NOTION_API_BASE: `http://127.0.0.1:${server.address().port}`, PM_ASK_POLL_MS: '20', NOTION_API_KEY: 'test-token', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (rc) => resolve({ rc, out }));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(D, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(D, 'results'), { recursive: true });
  fs.writeFileSync(path.join(D, 'cards', 'T03-schema.md'), '# T03 schema 单测\n卡片正文');
  fs.writeFileSync(path.join(D, 'results', 'T03.md'), '# T03 执行结果\n**状态**: DONE');
  fs.writeFileSync(path.join(D, 'ledger.md'), '| 卡 | 标题 |\n|----|----|\n| T03 | schema 单测 | 无 | 执行中 | |\n| T30 | 别的卡 | 无 | 待派 | |\n');
  const base = ['--dispatch', D, '--task', 'T03'];

  let r = await run(['nope', ...base]);
  check('未知类型 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D]);
  check('缺 --task → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', '--dispatch', D, '--task', 't3']);
  check('卡号格式不对 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', ...base]);
  check('缺 cloud-pm.json → 退出码 2', r.rc === 2 && /cloud-pm\.json/.test(r.out), r.out);

  fs.writeFileSync(path.join(D, 'cloud-pm.json'), JSON.stringify({ agent_id: 'agent-1', project: '演示', project_page: 'https://www.notion.so/demo' }));
  r = await run(['blocked', ...base, '--msg', 'x'], { NOTION_API_KEY: '' });
  check('缺令牌 → 退出码 2', r.rc === 2, r.out);
  r = await run(['blocked', ...base, '--msg', 'x'], { NOTION_API_KEY: 'wrong' });
  check('令牌错误 → 退出码 1 并带接口错误码', r.rc === 1 && /401 unauthorized/.test(r.out), r.out);

  seen.length = 0; polls = 0; scenario = 'ok';
  r = await run(['merge', ...base, '--msg', '自测全绿']);
  check('正常回合 → 退出码 0', r.rc === 0, r.out);
  check('打印最新一条 agent.message', r.out.includes('先修 schema') && !r.out.includes('旧消息'), r.out);
  const create = seen.find((x) => x.method === 'POST' && x.url === '/v1/sessions');
  check('带 Notion-Version 头', create && create.headers['notion-version'] === '2026-03-11');
  check('请求体带 agent_id 与 metadata', create && create.body.agent_id === 'agent-1' && create.body.metadata.task === 'T03' && create.body.metadata.type === 'merge', JSON.stringify(create && create.body));
  check('消息里带台账行且不串到 T30', create && create.body.message.includes('| T03 | schema 单测') && !create.body.message.includes('T30'));
  check('merge 时附上结果文件', create && create.body.message.includes('**状态**: DONE'));
  check('prompt_context 带背景页与卡片', create && /notion\.so\/demo/.test(create.body.prompt_context) && create.body.prompt_context.includes('卡片正文'));
  check('message 不超过 10000 字符', create && create.body.message.length <= 10000);
  const work = path.join(D, 'work', 'T03');
  const files = fs.existsSync(work) ? fs.readdirSync(work) : [];
  const jf = files.find((f) => f.endsWith('.json'));
  check('只写在 work/T03/ 下，md 与 json 各一份', files.filter((f) => f.endsWith('.md')).length === 1 && !!jf, files.join(','));
  const dec = jf ? JSON.parse(fs.readFileSync(path.join(work, jf), 'utf8')) : {};
  check('JSON 决策块解析正确', dec.decision === 'fix' && dec.session === 'sess-1' && dec.task === 'T03', JSON.stringify(dec));

  seen.length = 0; polls = 0;
  r = await run(['blocked', ...base, '--msg', 'x']);
  const c2 = seen.find((x) => x.method === 'POST' && x.url === '/v1/sessions');
  check('blocked 不附结果文件', r.rc === 0 && c2 && !c2.body.message.includes('**状态**: DONE'), r.out);

  scenario = 'action'; polls = 0;
  r = await run(['merge', ...base, '--msg', 'x']);
  check('非交互终端遇到待批准 → 退出码 3，不自动批准', r.rc === 3 && /合并 PR/.test(r.out) && !seen.some((x) => x.body && x.body.actions), r.out);

  scenario = 'failed'; polls = 0;
  r = await run(['review', ...base, '--msg', 'x']);
  check('会话失败 → 退出码 1 并带原因', r.rc === 1 && /额度用完/.test(r.out), r.out);

  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`pm-ask 自测：${pass} 过，${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();

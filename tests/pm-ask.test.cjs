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

// ---------- 假 API：每个会话记轮次；续聊的第一次轮询故意返回上一轮的 completed ----------
let scenario = 'ok';
const seen = [];
const sessions = new Map();
let nextId = 1;
const reply = (n) => `第${n}轮建议：先修 schema 再重跑。\n\`\`\`json\n{"decision":"fix","reason":"第${n}轮","tasks":[]}\n\`\`\``;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: j });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { code: 'unauthorized', message: 'bad token' });
    if (req.method === 'POST' && req.url === '/v1/sessions') {
      if (j.actions) return send(200, { id: j.session_id, status: 'in_progress' });
      if (j.session_id) {
        const st = sessions.get(j.session_id);
        if (!st) return send(404, { code: 'object_not_found', message: 'session' });
        st.turns++; st.polls = 0;
        return send(200, { object: 'session', id: j.session_id, status: 'queued' });
      }
      const id = `sess-${nextId++}`;
      sessions.set(id, { turns: 1, polls: 0 });
      return send(200, { object: 'session', id, status: 'queued' });
    }
    let m = req.url.match(/^\/v1\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const st = sessions.get(m[1]);
      st.polls++;
      if (scenario === 'action') return send(200, { id: m[1], status: 'requires_action', required_actions: [{ action_id: 'a1', title: '合并 PR', options: [] }] });
      if (scenario === 'failed') return send(200, { id: m[1], status: 'failed', error: { code: 'x', message: '额度用完', retryable: false } });
      if (st.turns > 1 && st.polls === 1) return send(200, { id: m[1], status: 'completed' }); // 上一轮的残留状态
      return send(200, { id: m[1], status: st.polls < 3 ? 'in_progress' : 'completed' });
    }
    m = req.url.match(/^\/v1\/sessions\/([^/]+)\/events\/query$/);
    if (req.method === 'POST' && m) {
      const st = sessions.get(m[1]);
      const done = st.polls >= 3 ? st.turns : st.turns - 1;
      const results = [];
      for (let n = 1; n <= done; n++) {
        results.push({ sequence: n * 10 - 1, type: 'agent.message', content: [{ type: 'text', text: `第${n}轮中间消息` }] });
        results.push({ sequence: n * 10, type: 'agent.message', content: [{ type: 'text', text: reply(n) }] });
      }
      return send(200, { results: results.reverse(), has_more: false, next_cursor: null });
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
const creates = () => seen.filter((x) => x.method === 'POST' && x.url === '/v1/sessions' && !x.body.actions);
const sessFile = (t) => path.join(D, 'work', t, 'pm-session.json');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(D, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(D, 'results'), { recursive: true });
  fs.writeFileSync(path.join(D, 'cards', 'T03-schema.md'), '# T03 schema 单测\n卡片正文');
  fs.writeFileSync(path.join(D, 'results', 'T03.md'), '# T03 执行结果\n**状态**: DONE');
  fs.writeFileSync(path.join(D, 'ledger.md'), '| 卡 | 标题 |\n|----|----|\n| T03 | schema 单测 | 无 | 执行中 | |\n| T30 | 别的卡 | 无 | 待派 | |\n');
  const base = ['--dispatch', D, '--task', 'T03'];

  // ---------- 参数与配置 ----------
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

  // ---------- 首次呼叫：新开会话 ----------
  seen.length = 0;
  r = await run(['merge', ...base, '--msg', '自测全绿']);
  check('首次呼叫 → 退出码 0', r.rc === 0, r.out);
  check('打印本轮最后一条 agent.message', r.out.includes('第1轮建议') && !r.out.includes('中间消息'), r.out);
  const c1 = creates()[0];
  check('带 Notion-Version 头', c1 && c1.headers['notion-version'] === '2026-03-11');
  check('新开会话：带 agent_id 与 metadata，不带 session_id', c1 && c1.body.agent_id === 'agent-1' && !c1.body.session_id && c1.body.metadata.task === 'T03' && c1.body.metadata.type === 'merge', JSON.stringify(c1 && c1.body));
  check('消息里带台账行且不串到 T30', c1 && c1.body.message.includes('| T03 | schema 单测') && !c1.body.message.includes('T30'));
  check('merge 时附上结果文件', c1 && c1.body.message.includes('**状态**: DONE'));
  check('prompt_context 带背景页与卡片', c1 && /notion\.so\/demo/.test(c1.body.prompt_context) && c1.body.prompt_context.includes('卡片正文'));
  check('message 不超过 10000 字符', c1 && c1.body.message.length <= 10000);
  const sid1 = fs.existsSync(sessFile('T03')) ? JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8')) : {};
  check('会话编号与已读序号存进 work/T03/pm-session.json', sid1.session_id === 'sess-1' && sid1.last_sequence === 10, JSON.stringify(sid1));
  const work = path.join(D, 'work', 'T03');
  let files = fs.readdirSync(work);
  const jf = files.find((f) => f.endsWith('.json') && f.startsWith('pm-reply-'));
  check('只写在 work/T03/ 下，md 与 json 各一份', files.filter((f) => f.endsWith('.md')).length === 1 && !!jf, files.join(','));
  const dec = jf ? JSON.parse(fs.readFileSync(path.join(work, jf), 'utf8')) : {};
  check('JSON 决策块解析正确', dec.decision === 'fix' && dec.session === 'sess-1' && dec.task === 'T03', JSON.stringify(dec));

  // ---------- 同一张卡第二次：续用原会话 ----------
  seen.length = 0;
  r = await run(['blocked', ...base, '--msg', '照做后仍红']);
  const c2 = creates()[0];
  check('同卡第二次 → 续用原会话（带 session_id，不带 agent_id）', r.rc === 0 && c2 && c2.body.session_id === 'sess-1' && !c2.body.agent_id, r.out + JSON.stringify(c2 && c2.body));
  check('续聊不被上一轮残留的 completed 骗：打印的是第2轮回复', r.out.includes('第2轮建议') && !r.out.includes('第1轮建议'), r.out);
  check('blocked 不附结果文件', c2 && !c2.body.message.includes('**状态**: DONE'));
  const sid2 = JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8'));
  check('已读序号推进到第2轮', sid2.session_id === 'sess-1' && sid2.last_sequence === 20, JSON.stringify(sid2));

  // ---------- --new 强制新开；不同的卡各开各的 ----------
  seen.length = 0;
  r = await run(['review', ...base, '--msg', 'x', '--new']);
  const c3 = creates()[0];
  check('--new → 新开会话', r.rc === 0 && c3 && c3.body.agent_id && !c3.body.session_id && JSON.parse(fs.readFileSync(sessFile('T03'), 'utf8')).session_id === 'sess-2', r.out);
  seen.length = 0;
  r = await run(['blocked', '--dispatch', D, '--task', 'T04', '--msg', 'x']);
  const c4 = creates()[0];
  check('另一张卡 → 自己新开会话', r.rc === 0 && c4 && !c4.body.session_id && JSON.parse(fs.readFileSync(sessFile('T04'), 'utf8')).session_id === 'sess-3', r.out);

  // ---------- 原会话续不上：自动新开 ----------
  fs.writeFileSync(sessFile('T04'), JSON.stringify({ session_id: 'sess-gone', last_sequence: 10 }));
  seen.length = 0;
  r = await run(['blocked', '--dispatch', D, '--task', 'T04', '--msg', 'x']);
  const cs = creates();
  check('原会话 404 → 自动新开并覆盖记录', r.rc === 0 && cs.length === 2 && cs[0].body.session_id === 'sess-gone' && cs[1].body.agent_id && /改为新开/.test(r.out) && r.out.includes('第1轮建议'), r.out);

  // ---------- 待批准与失败 ----------
  scenario = 'action';
  seen.length = 0;
  r = await run(['merge', ...base, '--msg', 'x', '--new']);
  check('非交互终端遇到待批准 → 退出码 3，不自动批准', r.rc === 3 && /合并 PR/.test(r.out) && !seen.some((x) => x.body && x.body.actions), r.out);

  scenario = 'failed';
  r = await run(['review', ...base, '--msg', 'x', '--new']);
  check('会话失败 → 退出码 1 并带原因', r.rc === 1 && /额度用完/.test(r.out), r.out);

  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`pm-ask 自测：${pass} 过，${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();

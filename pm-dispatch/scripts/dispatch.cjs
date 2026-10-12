#!/usr/bin/env node
'use strict';
// 调度器：读 cards/ 与 ledger.md，算出"现在能派哪几张"，生成启动语，可选直接拉起无头执行器。
// 取代"按批次一刀切"：一张卡的前置全部 PASS、且与在跑的卡不抢独占资源/不写同一路径，就立刻可派（流水线）。
//
// 用法:
//   node dispatch.cjs status <.dispatch/功能名 绝对路径>
//   node dispatch.cjs next   <.dispatch/功能名 绝对路径> [--max N] [--agent 子代理名]
//   node dispatch.cjs run    <.dispatch/功能名 绝对路径> --exec "命令模板" [--max N] [--timeout 分钟]
//
// next：为可派的卡写 prompts/卡号.txt 并打印启动语（手动粘贴，或交给客户端的子代理工具）。
//       加 --agent 时改为打印一整段派发指令：点名该子代理、每张卡一个、并行启动，PM 原样交给自己的子代理工具。
//       子代理怎么配（钉 flash 模型）见 references/executors.md。
// run ：对每张可派的卡并行执行 --exec 模板，模板里用 %PROMPT_FILE% %CARD% %CARD_ID% %RESULT% %WORK%
//       代表本卡的文件路径（脚本替换为带引号的绝对路径），所有执行器结束后汇总退出码。
//       日志写到 work/卡号/_exec.log。执行器把结果写进 results/卡号.md，验收仍由 PM 做。
//
// ledger.md 里的表格需要有「卡」「状态」两列，可选「验收」列：
//   状态 = 待派 | 执行中 | 已回 | 打回 | BLOCKED | 放行；验收列以 PASS 开头、或状态为"放行"，视为前置已满足。
// 并发上限读 ledger 里的"并发上限 N"，--max 可覆盖，默认 3。
// 派发开关读 ledger 里的"派发方式 手动|子代理|无头"（不写 = 自动，PM 按客户端能力选）：
//   手动 → 拒绝 next --agent 和 run，只打印启动语给用户粘贴；子代理 → 拒绝 run；无头 → 拒绝 next --agent。
//   被拒时在写 prompts、改名旧结果之前就退出（退出码 2）。
// 退出码: 0 正常 / 1 run 中有执行器失败或没有可派的卡 / 2 用法或数据错误

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./lib/card.cjs');

function parseArgs(argv) {
  const [cmd, dir, ...rest] = argv;
  const opt = { max: null, exec: null, timeout: 60, agent: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--max') opt.max = parseInt(rest[++i], 10);
    else if (a === '--exec') opt.exec = rest[++i];
    else if (a === '--timeout') opt.timeout = parseFloat(rest[++i]);
    else if (a === '--agent') opt.agent = rest[++i];
    else if (a.startsWith('--agent=')) opt.agent = a.slice(8);
    else if (a.startsWith('--max=')) opt.max = parseInt(a.slice(6), 10);
    else if (a.startsWith('--exec=')) opt.exec = a.slice(7);
    else if (a.startsWith('--timeout=')) opt.timeout = parseFloat(a.slice(10));
    else throw new Error(`未知参数 ${a}`);
  }
  if (opt.agent !== null && !/^[\w.-]+$/.test(opt.agent || '')) {
    throw new Error(`--agent 子代理名只能含字母、数字、下划线、点、连字符: ${opt.agent}`);
  }
  if (!['status', 'next', 'run'].includes(cmd) || !dir) {
    throw new Error('用法: dispatch.cjs status|next|run <.dispatch/功能名 绝对路径> [--max N] [--exec "模板"] [--agent 子代理名]');
  }
  if (cmd === 'run' && !opt.exec) throw new Error('run 需要 --exec "命令模板"');
  return { cmd, dir: path.resolve(dir.replace(/^"|"$/g, '')), opt };
}

function readLedger(dir) {
  const f = path.join(dir, 'ledger.md');
  const rows = new Map();
  let limit = null;
  let mode = null;
  if (!fs.existsSync(f)) return { rows, limit, mode, exists: false };
  const text = fs.readFileSync(f, 'utf8');
  const m = /并发上限\s*[:：]?\s*(\d+)/.exec(text);
  if (m) limit = parseInt(m[1], 10);
  const md = /派发方式\s*[:：]?\s*\**\s*(手动|人工|子代理|无头|自动)/.exec(text);
  if (md) mode = md[1] === '人工' ? '手动' : md[1] === '自动' ? null : md[1];
  let cols = null;
  for (const ln of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(ln)) { cols = null; continue; }
    const cells = ln.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
    if (!cols) {
      if (cells.includes('卡') && cells.includes('状态')) cols = cells;
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const get = (name) => { const i = cols.indexOf(name); return i >= 0 ? (cells[i] || '') : ''; };
    const id = get('卡').replace(/\*+/g, '');
    if (id) rows.set(id, { state: get('状态').replace(/\*+/g, ''), verdict: get('验收').replace(/\*+/g, '') });
  }
  return { rows, limit, mode, exists: true };
}

function classify(row) {
  if (!row) return '待派';
  const s = row.state, v = row.verdict;
  if (/^PASS/i.test(v) || /放行|已提交|DONE/i.test(s)) return '放行';
  if (/打回/.test(s) || /打回|^FAIL/i.test(v)) return '打回';
  if (/BLOCKED/i.test(s)) return 'BLOCKED';
  if (/执行中|进行中/.test(s)) return '执行中';
  if (/已回/.test(s)) return '已回';
  return '待派';
}

function exclusiveClash(a, b) {
  const norm = (x) => x.toLowerCase().replace(/\s+/g, '');
  const ea = a.exclusive.map(norm), eb = b.exclusive.map(norm);
  const res = ea.find((x) => eb.includes(x));
  if (res) return `独占资源 ${res}`;
  const w = a.writes.find((p) => b.writes.some((q) => C.overlap(p, q)));
  if (w) return `写同一路径 ${w}`;
  return null;
}

function plan(dir) {
  const cardsDir = path.join(dir, 'cards');
  if (!fs.existsSync(cardsDir)) throw new Error(`找不到 cards 目录: ${cardsDir}`);
  const cards = C.listCards(cardsDir).map((f) => C.parseCard(f));
  const ledger = readLedger(dir);
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) c.state = classify(ledger.rows.get(c.id));
  for (const c of cards) {
    c.missingDeps = c.blockedBy.filter((d) => !byId.has(d) && classify(ledger.rows.get(d)) !== '放行');
    c.waitingOn = c.blockedBy.filter((d) => byId.has(d) ? byId.get(d).state !== '放行' : !(classify(ledger.rows.get(d)) === '放行'));
  }
  const running = cards.filter((c) => c.state === '执行中');
  const candidates = cards.filter((c) => c.state === '待派' && c.waitingOn.length === 0 && !/^S/.test(c.type || c.id));
  return { cards, ledger, running, candidates };
}

function pickReady(p, max) {
  const slots = Math.max(0, max - p.running.length);
  const chosen = [];
  const reasons = new Map();
  // 关键路径优先：被越多卡（间接）依赖的先派
  const weight = (id) => p.cards.filter((c) => dependsOn(p, c.id, id)).length;
  const sorted = [...p.candidates].sort((a, b) => weight(b.id) - weight(a.id) || a.id.localeCompare(b.id));
  for (const c of sorted) {
    const clashRun = p.running.map((r) => [r, exclusiveClash(c, r)]).find(([, x]) => x);
    if (clashRun) { reasons.set(c.id, `与在跑的 ${clashRun[0].id} 冲突：${clashRun[1]}`); continue; }
    const clashSel = chosen.map((r) => [r, exclusiveClash(c, r)]).find(([, x]) => x);
    if (clashSel) { reasons.set(c.id, `与同轮的 ${clashSel[0].id} 冲突：${clashSel[1]}`); continue; }
    if (chosen.length >= slots) { reasons.set(c.id, `并发已满（上限 ${max}）`); continue; }
    chosen.push(c);
  }
  return { chosen, reasons };
}

function dependsOn(p, a, b, seen = new Set()) {
  const c = p.cards.find((x) => x.id === a);
  if (!c || seen.has(a)) return false;
  seen.add(a);
  return c.blockedBy.includes(b) || c.blockedBy.some((d) => dependsOn(p, d, b, seen));
}

function pathsFor(dir, c) {
  return {
    card: c.file,
    result: path.join(dir, 'results', `${c.id}.md`),
    work: path.join(dir, 'work', c.id) + path.sep,
    prompt: path.join(dir, 'prompts', `${c.id}.txt`),
  };
}

function launchText(dir, c) {
  const p = pathsFor(dir, c);
  return [
    `你是执行 agent，只按任务卡干活。先完整读取任务卡：${p.card}`,
    `产物只写入：${p.work}`,
    `结果按卡片「回传契约」写入：${p.result}`,
    '不要向用户提问；卡片没覆盖的情况在结果文件里记 BLOCKED 后停止。严禁把未实跑验证的项写成 DONE。',
    '完成后只回复一行：结果文件路径 + 状态词（DONE / PARTIAL / FAILED / BLOCKED）。',
  ].join('\n');
}

// 一整段派发指令：PM 交给自己的子代理工具（Qoder / ZCode / Codex 都靠点名自定义子代理来钉模型）
function agentText(dir, chosen, agent) {
  const out = [
    `并行启动 ${chosen.length} 个 ${agent} 子代理，每张卡一个，必须使用 ${agent}，不要换成 general-purpose / default 或自己动手。`,
    '把每张卡下面的任务原文一字不改地交给对应的子代理。等全部返回后，只汇总每张卡回复的那一行（结果文件路径 + 状态词），不要替它们补做或修改产物。',
  ];
  for (const c of chosen) out.push('', `=== ${c.id} ===`, launchText(dir, c));
  return out.join('\n');
}

function printStatus(p, max) {
  console.log(`卡片 ${p.cards.length} 张 | 并发上限 ${max} | 派发方式 ${p.ledger.mode || '自动'} | ledger ${p.ledger.exists ? '已读' : '不存在（全部按待派处理）'}`);
  for (const c of p.cards) {
    const deps = c.blockedBy.length ? c.blockedBy.join(',') : '无';
    const wait = c.waitingOn.length ? `  等 ${c.waitingOn.join(',')}` : '';
    const miss = c.missingDeps.length ? `  !! 前置卡不存在：${c.missingDeps.join(',')}` : '';
    console.log(`  ${c.id.padEnd(5)} ${c.state.padEnd(7)} 依赖 ${deps}${wait}${miss}`);
  }
}

function writePrompts(dir, chosen) {
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const c of chosen) {
    const p = pathsFor(dir, c);
    fs.mkdirSync(p.work, { recursive: true });
    fs.mkdirSync(path.dirname(p.result), { recursive: true });
    if (fs.existsSync(p.result)) { // 重派：旧结果改名留档，避免把上一轮的结果当成这一轮的
      let n = 1;
      while (fs.existsSync(`${p.result}.retry${n}`)) n++;
      fs.renameSync(p.result, `${p.result}.retry${n}`);
      console.log(`${c.id} 旧结果已改名为 ${path.basename(p.result)}.retry${n}`);
    }
    fs.writeFileSync(p.prompt, launchText(dir, c) + '\n');
  }
}

function q(s) { return `"${s.replace(/"/g, '\\"')}"`; }

function runOne(dir, c, template, timeoutMin) {
  const p = pathsFor(dir, c);
  const cmd = template
    .replace(/%PROMPT_FILE%/g, q(p.prompt)).replace(/%CARD%/g, q(p.card))
    .replace(/%CARD_ID%/g, c.id).replace(/%RESULT%/g, q(p.result)).replace(/%WORK%/g, q(p.work));
  const log = fs.openSync(path.join(p.work, '_exec.log'), 'a');
  fs.writeSync(log, `\n=== ${new Date().toISOString()} ${cmd}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd: dir, stdio: ['ignore', log, log] });
    const timer = setTimeout(() => { child.kill(); }, timeoutMin * 60 * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(log);
      resolve({ c, code, signal, secs: Math.round((Date.now() - started) / 1000), hasResult: fs.existsSync(p.result) });
    });
    child.on('error', (e) => { clearTimeout(timer); fs.writeSync(log, String(e)); });
  });
}

async function main() {
  const { cmd, dir, opt } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const p = plan(dir);
  const max = opt.max || p.ledger.limit || 3;
  const mode = p.ledger.mode;
  const how = cmd === 'run' ? '无头' : cmd === 'next' && opt.agent ? '子代理' : cmd === 'next' ? '手动' : null;
  if (mode && how && how !== '手动' && how !== mode) { // 不带 --agent 的 next 只打印启动语，任何方式下都允许
    throw new Error(`ledger 设了"派发方式 ${mode}"，不允许${how === '无头' ? ' run（无头 CLI）' : ' next --agent（子代理）'}。` +
      (mode === '手动' ? '用 next（不带 --agent）打印启动语交给用户粘贴；' : mode === '子代理' ? '用 next --agent 子代理名；' : '用 run --exec；') +
      '要换方式先改 ledger 里那一行。');
  }

  if (cmd === 'status') {
    printStatus(p, max);
    const { chosen, reasons } = pickReady(p, max);
    console.log(`\n现在可派: ${chosen.map((c) => c.id).join(', ') || '无'}`);
    for (const [id, why] of reasons) console.log(`  暂缓 ${id}：${why}`);
    process.exit(0);
  }

  const { chosen, reasons } = pickReady(p, max);
  for (const [id, why] of reasons) console.log(`暂缓 ${id}：${why}`);
  if (!chosen.length) {
    console.log('没有可派的卡（前置未放行、并发已满，或全部完成）。先跑 status 看原因。');
    process.exit(1);
  }
  writePrompts(dir, chosen);

  if (cmd === 'next' && opt.agent) {
    console.log(agentText(dir, chosen, opt.agent));
    console.log(`\n已写入 ${chosen.length} 份启动语到 ${path.join(dir, 'prompts')}。把上面整段交给子代理工具；派出后把这些卡在 ledger 里改成"执行中"。`);
    process.exit(0);
  }

  if (cmd === 'next') {
    for (const c of chosen) {
      console.log(`\n----- ${c.id} ${c.title.replace(/^[A-Z]\d+[a-z]?\s*/, '')} -----`);
      console.log(launchText(dir, c));
    }
    console.log(`\n已写入 ${chosen.length} 份启动语到 ${path.join(dir, 'prompts')}。派出后把这些卡在 ledger 里改成"执行中"。`);
    process.exit(0);
  }

  // run
  console.log(`并行拉起 ${chosen.length} 个执行器：${chosen.map((c) => c.id).join(', ')}（单卡超时 ${opt.timeout} 分钟）`);
  const results = await Promise.all(chosen.map((c) => runOne(dir, c, opt.exec, opt.timeout)));
  let bad = 0;
  for (const r of results) {
    const ok = r.code === 0 && r.hasResult;
    if (!ok) bad++;
    console.log(`  ${r.c.id.padEnd(5)} rc=${r.code}${r.signal ? ' ' + r.signal : ''} ${r.secs}s 结果文件${r.hasResult ? '已写' : '缺失'}  ${ok ? '待验收' : '异常，看 work/' + r.c.id + '/_exec.log'}`);
  }
  console.log(`\n执行器全部结束：${results.length - bad} 张待验收，${bad} 张异常。退出码 0 只代表执行器跑完，不代表通过——按 references/acceptance.md 验收。`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.log(`ERROR ${e.message}`); process.exit(2); });

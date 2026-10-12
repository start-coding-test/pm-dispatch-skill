#!/usr/bin/env node
'use strict';
// 调度器：读 cards/ 与 ledger.md，算出"现在能派哪几张"，生成启动语交给用户粘贴到执行会话。
// 取代"按批次一刀切"：一张卡的前置全部 PASS、且与在跑的卡不抢独占资源/不写同一路径，就立刻可派（流水线）。
//
// 用法:
//   node dispatch.cjs status <.dispatch/功能名 绝对路径>
//   node dispatch.cjs next   <.dispatch/功能名 绝对路径> [--max N]
//
// next：为可派的卡写 prompts/卡号.txt 并打印启动语，一张卡开一个执行会话粘贴进去。
//       （自动派发——子代理 / 无头 CLI——因各 harness 结构不同，暂不支持。）
//
// ledger.md 里的表格需要有「卡」「状态」两列，可选「验收」列：
//   状态 = 待派 | 执行中 | 已回 | 打回 | BLOCKED | 放行；验收列以 PASS 开头、或状态为"放行"，视为前置已满足。
// 并发上限读 ledger 里的"并发上限 N"，--max 可覆盖，默认 3。
// 退出码: 0 正常 / 1 没有可派的卡 / 2 用法或数据错误

const fs = require('fs');
const path = require('path');
const C = require('./lib/card.cjs');

function parseArgs(argv) {
  const [cmd, dir, ...rest] = argv;
  if (!['status', 'next'].includes(cmd) || !dir) {
    throw new Error('用法: dispatch.cjs status|next <.dispatch/功能名 绝对路径> [--max N]（自动派发 run / --agent 暂不支持）');
  }
  const opt = { max: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--max') opt.max = parseInt(rest[++i], 10);
    else if (a.startsWith('--max=')) opt.max = parseInt(a.slice(6), 10);
    else throw new Error(`未知参数 ${a}`);
  }
  return { cmd, dir: path.resolve(dir.replace(/^"|"$/g, '')), opt };
}

function readLedger(dir) {
  const f = path.join(dir, 'ledger.md');
  const rows = new Map();
  let limit = null;
  if (!fs.existsSync(f)) return { rows, limit, exists: false };
  const text = fs.readFileSync(f, 'utf8');
  const m = /并发上限\s*[:：]?\s*(\d+)/.exec(text);
  if (m) limit = parseInt(m[1], 10);
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
  return { rows, limit, exists: true };
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

function printStatus(p, max) {
  console.log(`卡片 ${p.cards.length} 张 | 并发上限 ${max} | ledger ${p.ledger.exists ? '已读' : '不存在（全部按待派处理）'}`);
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

function main() {
  const { cmd, dir, opt } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const p = plan(dir);
  const max = opt.max || p.ledger.limit || 3;

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

  for (const c of chosen) {
    console.log(`\n----- ${c.id} ${c.title.replace(/^[A-Z]\d+[a-z]?\s*/, '')} -----`);
    console.log(launchText(dir, c));
  }
  console.log(`\n已写入 ${chosen.length} 份启动语到 ${path.join(dir, 'prompts')}。一张卡开一个执行会话粘贴；派出后把这些卡在 ledger 里改成"执行中"。`);
  process.exit(0);
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

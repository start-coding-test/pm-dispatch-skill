#!/usr/bin/env node
'use strict';
// 变异抽查驱动：把被测代码逐点改坏，看断言会不会红。不红 = 那条断言根本没在判定。
//
// 用法:
//   node mutate-check.cjs --plan <plan.json 绝对路径> [--no-baseline] [--keep-backup] [--only M1,M3] [--timeout 秒]
// plan.json:
//   {
//     "repo": "D:/proj",
//     "timeout": 120,                       // 可选，单次命令超时秒数，默认 120
//     "cases": [
//       { "id": "M1", "file": "src/parser.js", "from": "return 30;", "to": "return 10;",
//         "cmd": "node tests/unit.mjs",
//         "expect": "北交所"                 // 可选：杀掉时输出里必须出现这段（证明是"对的那条"断言红了）
//         "shell": false                     // 可选：要跑 npm/npx/pnpm 这类 .cmd shim 时设 true
//       }
//     ]
//   }
//   file 相对 repo（也接受绝对路径）；from 必须唯一命中该文件里的一处，否则 SKIP 并计为未验证；
//   to 可以是空串（等于删掉这一段）；cmd 支持带引号的参数（路径里有空格也行）。
// 安全性：
//   - 只改 plan 里列出的文件；先按原始字节整份备份到 <repo>/temp/mutate-check-<时间戳>/；
//   - 每个 case 跑之前先把所有文件还原，只施加这一个变异；
//   - Ctrl+C / 被杀 / 异常都会先还原；结束时按 Buffer 逐字节校验（不依赖 git，未跟踪文件也安全）；
//   - 默认先跑基线：基线不绿直接中止——基线红时"杀掉"判定没有意义。
// 退出码: 0 = 全部杀掉；1 = 有变异没被杀掉或锚点无效；2 = 用法错误 / 基线不绿 / 还原失败。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  let planPath = null;
  const opt = { baseline: true, keepBackup: false, only: null, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') planPath = argv[++i];
    else if (a.startsWith('--plan=')) planPath = a.slice(7);
    else if (a === '--baseline') opt.baseline = true; // 兼容旧参数，现在默认就跑
    else if (a === '--no-baseline') opt.baseline = false;
    else if (a === '--keep-backup') opt.keepBackup = true;
    else if (a === '--only') opt.only = new Set(argv[++i].split(','));
    else if (a.startsWith('--only=')) opt.only = new Set(a.slice(7).split(','));
    else if (a === '--timeout') opt.timeout = Number(argv[++i]);
    else throw new Error(`未知参数 ${a}`);
  }
  if (!planPath) throw new Error('缺少 --plan <plan.json 绝对路径>');
  return { planPath: path.resolve(planPath.replace(/^"|"$/g, '')), opt };
}

function loadPlan(p) {
  if (!fs.existsSync(p)) throw new Error(`plan 文件不存在: ${p}`);
  const plan = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  if (!plan.repo || !fs.existsSync(plan.repo)) throw new Error('plan.repo 必须是存在的绝对路径');
  if (!Array.isArray(plan.cases) || !plan.cases.length) throw new Error('plan.cases 不能为空');
  const ids = new Set();
  for (const c of plan.cases) {
    if (!c.id || !c.file || !c.from || !c.cmd) throw new Error(`case 缺字段（需要 id/file/from/cmd）: ${JSON.stringify(c)}`);
    if (typeof c.to !== 'string') throw new Error(`case ${c.id} 的 to 必须是字符串（可以是空串）`);
    if (c.from === c.to) throw new Error(`case ${c.id} 的 from 与 to 相同，不是变异`);
    if (ids.has(c.id)) throw new Error(`case id 重复: ${c.id}`);
    ids.add(c.id);
  }
  return plan;
}

const abs = (plan, rel) => (path.isAbsolute(rel) ? rel : path.join(plan.repo, rel));

// 引号感知的参数切分：node "D:\my proj\t.mjs" --x 'a b'
function splitArgs(cmd) {
  const out = [];
  let cur = '', q = null, has = false;
  for (const ch of cmd.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (q) throw new Error(`命令引号不配对: ${cmd}`);
  if (cur || has) out.push(cur);
  return out;
}

function runCmd(repo, c, timeoutSec) {
  const opts = { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutSec * 1000, windowsHide: true };
  const r = c.shell ? spawnSync(c.cmd, { ...opts, shell: true }) : (() => { const [b, ...a] = splitArgs(c.cmd); return spawnSync(b, a, opts); })();
  const out = (r.stdout || '') + (r.stderr || '');
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const spawnErr = r.error && !timedOut ? r.error.message : null;
  const resultLine = out.split('\n').map((l) => l.trim()).filter((l) => /^(RESULT|OK|FAILED|ERROR|Tests?:|# (pass|fail))/i.test(l)).pop() || '';
  const fails = r.status !== 0 ||
    /^\s*(FAIL|not ok)\b/m.test(out) ||
    /\bfail(?:ures?|ed)?\s*[=:]\s*[1-9]/i.test(out) ||
    /\b[1-9]\d*\s+(?:failed|failing|failures?)\b/i.test(out) ||
    /^\s*✗/m.test(out);
  return { rc: r.status === null ? -1 : r.status, out, resultLine, fails, timedOut, spawnErr,
    head: out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' / ') };
}

function main() {
  const { planPath, opt } = parseArgs(process.argv.slice(2));
  const plan = loadPlan(planPath);
  const timeoutSec = opt.timeout || plan.timeout || 120;
  const cases = plan.cases.filter((c) => !opt.only || opt.only.has(c.id));
  if (!cases.length) throw new Error('--only 过滤后没有用例');

  // 1) 按原始字节备份（不经过 utf8 解码，GBK/BOM/CRLF 都原样保住）
  const files = [...new Set(cases.map((c) => abs(plan, c.file)))];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backupDir = path.join(plan.repo, 'temp', `mutate-check-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const originals = new Map();
  const manifest = [];
  files.forEach((f, i) => {
    if (!fs.existsSync(f)) throw new Error(`文件不存在: ${f}`);
    const buf = fs.readFileSync(f);
    originals.set(f, buf);
    const bak = path.join(backupDir, `${String(i).padStart(2, '0')}-${path.basename(f)}.bak`);
    fs.writeFileSync(bak, buf);
    manifest.push({ file: f, backup: bak });
  });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`仓库 ${plan.repo}`);
  console.log(`用例 ${cases.length} 个、涉及文件 ${files.length} 个、单次超时 ${timeoutSec}s → 备份在 ${backupDir}`);

  const restore = () => { for (const [f, buf] of originals) fs.writeFileSync(f, buf); };
  const verify = () => [...originals].filter(([f, buf]) => !fs.readFileSync(f).equals(buf)).map(([f]) => f);

  // 被中断时也必须还原：否则仓库里会留下一处"被改坏的代码"
  let finished = false;
  const onSignal = (sig) => {
    if (finished) return;
    try { restore(); } catch (_) { /* 下面会报 */ }
    const bad = verify();
    console.log(`\n!! 收到 ${sig}，已还原 ${files.length - bad.length}/${files.length} 个文件${bad.length ? '；未还原：' + bad.join(', ') + '，按 ' + backupDir + '/manifest.json 手工恢复' : ''}`);
    process.exit(2);
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => onSignal(s));

  try {
    // 2) 基线
    if (opt.baseline) {
      restore();
      console.log('\n基线（未变异）:');
      const seen = new Set();
      let red = false;
      for (const c of cases) {
        if (seen.has(c.cmd)) continue;
        seen.add(c.cmd);
        const r = runCmd(plan.repo, c, timeoutSec);
        console.log(`  ${c.cmd}  → rc=${r.rc}${r.timedOut ? ' 超时' : ''} ${r.spawnErr || r.resultLine || r.head}`);
        if (r.fails) red = true;
      }
      if (red) {
        restore();
        console.log('\n结论: 基线就不绿，中止。先修测试（或换成绿的命令）再抽查，否则"杀掉"判定无意义。');
        finished = true;
        fs.rmSync(backupDir, { recursive: true, force: true });
        process.exit(2);
      }
    }

    // 3) 逐个变异
    let survived = 0, skipped = 0, wrongKill = 0;
    console.log('');
    for (const c of cases) {
      restore();
      const target = abs(plan, c.file);
      const text = originals.get(target).toString('utf8');
      const hits = text.split(c.from).length - 1;
      if (hits === 0) { console.log(`${c.id}  SKIP：锚点找不到（未验证，不算杀掉）:: ${c.from.slice(0, 60)}`); skipped++; continue; }
      if (hits > 1) { console.log(`${c.id}  SKIP：锚点命中 ${hits} 处，不唯一（把 from 写长一点）`); skipped++; continue; }
      fs.writeFileSync(target, text.replace(c.from, () => c.to));
      const r = runCmd(plan.repo, c, timeoutSec);
      if (r.spawnErr) { console.log(`${c.id}  ERROR：命令起不来 :: ${r.spawnErr}`); skipped++; continue; }
      let verdict;
      if (!r.fails) { survived++; verdict = '没杀掉（恒真/覆盖不足）'; }
      else if (/SyntaxError|ReferenceError: \S+ is not defined|Cannot find module|error TS\d+|IndentationError/.test(r.out)) { wrongKill++; verdict = '红了但是崩溃/语法错（不证明断言有效，换一个语义变异）'; }
      else if (c.expect && !r.out.includes(c.expect)) { wrongKill++; verdict = `红了但不是预期那条（输出里没有"${c.expect}"）`; }
      else verdict = r.timedOut ? '杀掉（超时，变异导致死循环/挂起）' : '杀掉（断言有效）';
      console.log(`${c.id}  ${verdict}  rc=${r.rc} ${r.resultLine || r.head}`);
      const firstFail = r.out.split('\n').find((l) => /^\s*(FAIL|not ok|✗)|fail(?:ed)?[=:]\s*[1-9]/i.test(l));
      if (r.fails && firstFail) console.log(`     ↳ ${firstFail.trim().slice(0, 180)}`);
    }

    // 4) 还原并逐字节校验
    restore();
    const mismatch = verify();
    finished = true;
    console.log('');
    if (mismatch.length) {
      console.log(`!! 还原后与原件不一致，按 ${backupDir}/manifest.json 手工恢复：\n   ${mismatch.join('\n   ')}`);
      process.exit(2);
    }
    console.log(`还原校验：${files.length} 个文件逐字节一致`);
    if (!opt.keepBackup) fs.rmSync(backupDir, { recursive: true, force: true });
    else console.log(`备份保留在 ${backupDir}`);
    const killed = cases.length - survived - skipped - wrongKill;
    const bad = survived + skipped + wrongKill;
    console.log(`\nRESULT cases=${cases.length} killed=${killed} survived=${survived} wrong_kill=${wrongKill} skipped=${skipped}`);
    console.log(`结论: ${bad === 0 ? `全部 ${killed} 个变异都被杀掉，断言确实在判定` :
      `${bad} 个没有有效杀掉（存活 ${survived}、红错地方 ${wrongKill}、锚点/命令无效 ${skipped}）—— 补断言、修锚点，或打回`}`);
    process.exit(bad === 0 ? 0 : 1);
  } catch (e) {
    restore();
    finished = true;
    console.log(`ERROR ${e.message}\n已还原，备份在 ${backupDir}`);
    process.exit(2);
  }
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

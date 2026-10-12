#!/usr/bin/env node
'use strict';
// 变异抽查驱动：把被测代码逐点改坏，看断言会不会红。
// 不红 = 那条断言根本没在判定。这是验收里性价比最高的一招。
//
// 用法:
//   node mutate-check.cjs --plan <plan.json 绝对路径> [--baseline] [--keep-backup]
// plan.json:
//   {
//     "repo": "D:/proj",
//     "cases": [
//       { "id": "M1", "file": "src/parser.js", "from": "return 30;", "to": "return 10;",
//         "cmd": "node tests/unit.mjs" }
//     ]
//   }
//   file 相对 repo（也接受绝对路径）；from 必须唯一命中该文件里的一处，找不到就报 SKIP；
//   to 可以是空串（等于删掉这一段）；cmd 用 shell:false 跑，必须以 node/可执行文件开头。
// 安全性：
//   - 只改 plan 里列出的文件；先整份备份到 <repo>/temp/mutate-check-<时间戳>/；
//   - 每个 case 跑之前先把所有文件还原成原样，只施加这一个变异；
//   - 结束时全部还原并**逐字节校验**（未跟踪文件不能靠 git checkout 还原，所以自带备份）。
// 退出码: 0 = 全部杀掉；1 = 有变异没被杀掉（断言恒真或覆盖不足）；2 = 用法错误。
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  let planPath = null;
  const opt = { baseline: false, keepBackup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') planPath = argv[++i];
    else if (a.startsWith('--plan=')) planPath = a.slice(7);
    else if (a === '--baseline') opt.baseline = true;
    else if (a === '--keep-backup') opt.keepBackup = true;
    else throw new Error(`未知参数 ${a}`);
  }
  if (!planPath) throw new Error('缺少 --plan <plan.json 绝对路径>');
  return { planPath: path.resolve(planPath.replace(/^"|"$/g, '')), opt };
}

function loadPlan(p) {
  if (!fs.existsSync(p)) throw new Error(`plan 文件不存在: ${p}`);
  const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!plan.repo || !fs.existsSync(plan.repo)) throw new Error('plan.repo 必须是存在的绝对路径');
  if (!Array.isArray(plan.cases) || !plan.cases.length) throw new Error('plan.cases 不能为空');
  for (const c of plan.cases) {
    if (!c.id || !c.file || !c.from || !c.cmd) throw new Error(`case 缺字段（需要 id/file/from/cmd）: ${JSON.stringify(c)}`);
    if (typeof c.to !== 'string') throw new Error(`case ${c.id} 的 to 必须是字符串（可以是空串）`);
  }
  return plan;
}

function abs(plan, rel) {
  return path.isAbsolute(rel) ? rel : path.join(plan.repo, rel);
}

function runCmd(repo, cmd) {
  const parts = cmd.trim().split(/\s+/);
  const r = spawnSync(parts[0], parts.slice(1), { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const resultLine = out.split('\n').map((l) => l.trim()).filter((l) => /^(RESULT|OK|FAILED|ERROR)/i.test(l)).pop() || '';
  // 判定"跑挂了"的通用形状：退出码非 0 / FAIL 行 / fail=N(N>0) / "N failed" / ✗
  const fails = r.status !== 0 ||
    /^FAIL\b/gm.test(out) ||
    /fail(?:ures?)?[=:]\s*[1-9]/i.test(out) ||
    /\b[1-9]\d*\s*(?:failed|failures)\b/i.test(out) ||
    /✗/.test(out);
  return { rc: r.status === null ? -1 : r.status, out, resultLine, fails,
    head: out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' / ') };
}

function main() {
  const { planPath, opt } = parseArgs(process.argv.slice(2));
  const plan = loadPlan(planPath);

  // 1) 备份所有涉及的源文件
  const files = [...new Set(plan.cases.map((c) => abs(plan, c.file)))];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backupDir = path.join(plan.repo, 'temp', `mutate-check-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const originals = new Map();
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`文件不存在: ${f}`);
    const text = fs.readFileSync(f, 'utf8');
    originals.set(f, text);
    fs.copyFileSync(f, path.join(backupDir, path.basename(f) + '.' + Math.abs([...f].reduce((a, ch) => a + ch.charCodeAt(0), 0)) + '.bak'));
  }
  console.log(`仓库 ${plan.repo}`);
  console.log(`用例 ${plan.cases.length} 个、涉及文件 ${files.length} 个 → 备份在 ${backupDir}`);

  const restore = () => { for (const [f, text] of originals) fs.writeFileSync(f, text); };

  try {
    // 2) 基线（不施加任何变异）
    if (opt.baseline) {
      restore();
      console.log('\n基线（未变异）:');
      const seen = new Set();
      for (const c of plan.cases) {
        if (seen.has(c.cmd)) continue;
        seen.add(c.cmd);
        const r = runCmd(plan.repo, c.cmd);
        console.log(`  ${c.cmd}  → rc=${r.rc} ${r.resultLine || r.head}`);
        if (r.rc !== 0) console.log('  !! 基线就不绿：先修测试再抽查，否则"杀掉"判定无意义');
      }
    }

    // 3) 逐个变异
    let survived = 0;
    let skipped = 0;
    console.log('');
    for (const c of plan.cases) {
      restore();
      const target = abs(plan, c.file);
      const text = originals.get(target);
      const hits = text.split(c.from).length - 1;
      if (hits === 0) { console.log(`${c.id}  SKIP：锚点在该文件里找不到（未验证，不算杀掉）:: ${c.from.slice(0, 60)}`); skipped++; survived++; continue; }
      if (hits > 1) { console.log(`${c.id}  SKIP：锚点命中 ${hits} 处，不唯一（把 from 写长一点）`); skipped++; survived++; continue; }
      fs.writeFileSync(target, text.replace(c.from, c.to));
      const r = runCmd(plan.repo, c.cmd);
      const killed = r.fails;
      if (!killed) survived++;
      console.log(`${c.id}  ${killed ? '杀掉（断言有效）' : '没杀掉（恒真/覆盖不足）'}  rc=${r.rc} ${r.resultLine || r.head}`);
      const firstFail = r.out.split('\n').filter((l) => /^FAIL|^✗|fail[=:][1-9]/i.test(l.trim()))[0];
      if (killed && firstFail) console.log(`     ↳ ${firstFail.trim().slice(0, 180)}`);
    }

    // 4) 还原并逐字节校验
    restore();
    let mismatch = [];
    for (const [f, text] of originals) if (fs.readFileSync(f, 'utf8') !== text) mismatch.push(f);
    console.log('');
    if (mismatch.length) {
      console.log(`!! 还原后与原件不一致，必须手工恢复：\n   ${mismatch.join('\n   ')}`);
      console.log(`   备份在 ${backupDir}`);
      process.exit(2);
    }
    console.log(`还原校验：${files.length} 个文件逐字节一致`);
    if (!opt.keepBackup) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) { console.log(`（备份目录没删掉：${e.message}）`); }
    } else {
      console.log(`备份保留在 ${backupDir}`);
    }
    const killed = plan.cases.length - survived;
    console.log(`\n结论: ${survived === 0 ? `全部 ${killed} 个变异都被杀掉，断言确实在判定` :
      `${survived} 个变异没被杀掉（其中锚点无效 ${skipped} 个）—— 补断言、修锚点，或打回`}`);
    process.exit(survived === 0 ? 0 : 1);
  } catch (e) {
    restore();
    console.log(`ERROR ${e.message}\n已尝试还原，备份在 ${backupDir}`);
    process.exit(2);
  }
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

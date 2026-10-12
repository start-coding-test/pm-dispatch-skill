#!/usr/bin/env node
'use strict';
// 断言/测试标题的机械核对：证明"回归没有变松"。
// 把 ref 版本里每条断言的标题抽出来，逐条到当前版本里找；消失的、次数变少的、新被 skip 掉的，都要逐条有名有姓。
// 人眼读 diff 会漏（改名、挪进循环、加 .skip），脚本不会。
//
// 用法:
//   node audit-assertions.cjs <仓库绝对路径> <相对文件路径[,更多]> [--ref HEAD]
//                             [--preset test|check|pytest|go] [--pattern '<JS正则，捕获组1是标题>'] [--show-added]
// 例:
//   node audit-assertions.cjs "D:/proj" "scripts/verify-x.mjs,src/a.test.ts" --preset check
// 退出码: 0 = 没有变松；1 = 有消失/减少/新增跳过（需逐条解释）；2 = 用法或环境错误。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRESETS = {
  // 自定义回归框架：r.check("标题", 期望, 实际)
  check: /\br\.check\(\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // jest / vitest / mocha / node:test，含 .only/.skip/.each 链式写法
  test: /\b(?:test|it|describe|context|suite)(?:\.(?:only|skip|todo|each\([^)]*\)|concurrent|failing))*\(\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // pytest：函数名就是标题
  pytest: /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm,
  // go test
  go: /^func\s+(Test\w+)\s*\(/gm,
};

// 被跳过的写法：标题出现在这些形状里，说明这条测试不再执行
const SKIP_PATTERNS = [
  /\b(?:test|it|describe|context|suite)\.(?:skip|todo)\(\s*["'`]([^"'`\n]{2,200})["'`]/g,
  /\bx(?:it|test|describe)\(\s*["'`]([^"'`\n]{2,200})["'`]/g,
  /@pytest\.mark\.(?:skip|xfail)[^\n]*\n\s*(?:async\s+)?def\s+(test_\w+)/g,
  /\b(?:test|it|describe)\([^\n]*\{\s*skip\s*:\s*true[^\n]*/g, // node:test 的 { skip: true }
];
const ONLY_RE = /\b(?:test|it|describe|context|suite)\.only\(|\bf(?:it|describe)\(/;

function parseArgs(argv) {
  const pos = [];
  const opt = { ref: 'HEAD', preset: 'test', pattern: null, showAdded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref' || a === '--preset' || a === '--pattern') opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--ref=')) opt.ref = a.slice(6);
    else if (a.startsWith('--preset=')) opt.preset = a.slice(9);
    else if (a.startsWith('--pattern=')) opt.pattern = a.slice(10);
    else if (a === '--show-added') opt.showAdded = true;
    else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
    else pos.push(a.replace(/^"|"$/g, ''));
  }
  if (pos.length < 2) throw new Error('参数不足：需要 <仓库绝对路径> 与 <相对文件路径[,更多]>');
  return { repo: path.resolve(pos[0]), files: pos[1].split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean), opt };
}

function gitShow(repo, ref, rel) {
  const r = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  const msg = ((r.stderr || (r.error && r.error.message) || '').trim().split('\n')[0]) || '';
  if (/does not exist in|exists on disk, but not in/.test(msg)) return null; // 该版本还没有这个文件
  throw new Error(`git show ${ref}:${rel} 失败 :: ${msg || '退出码 ' + r.status}`);
}

function makeExtractor(presetName, patternStr) {
  const src = patternStr ? new RegExp(patternStr, 'g') : PRESETS[presetName];
  if (!src) throw new Error(`未知 preset ${presetName}，可用：${Object.keys(PRESETS).join('/')}，或用 --pattern`);
  return (text) => [...text.matchAll(new RegExp(src.source, src.flags.includes('g') ? src.flags : src.flags + 'g'))]
    .map((m) => m[1]).filter(Boolean);
}

function skipped(text) {
  const s = new Set();
  for (const re of SKIP_PATTERNS) for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    const t = m[1] || (/["'`]([^"'`\n]{2,200})["'`]/.exec(m[0]) || [])[1];
    if (t) s.add(t);
  }
  return s;
}

function counts(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function main() {
  const { repo, files, opt } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(repo)) throw new Error(`仓库路径不存在: ${repo}`);
  const extract = makeExtractor(opt.preset, opt.pattern);
  let problems = 0;

  for (const rel of files) {
    const nowPath = path.join(repo, rel);
    const beforeText = gitShow(repo, opt.ref, rel);
    console.log(`\n### ${rel}   (对照 ${opt.ref})`);
    if (!fs.existsSync(nowPath)) {
      const n = beforeText ? new Set(extract(beforeText)).size : 0;
      console.log(`  !! 当前文件不存在（${opt.ref} 里有 ${n} 条标题）——整份回归被删，必须解释`);
      problems += Math.max(1, n);
      continue;
    }
    const nowText = fs.readFileSync(nowPath, 'utf8');
    if (beforeText === null) {
      console.log(`  新文件（${opt.ref} 里没有），${new Set(extract(nowText)).size} 条标题，无可对照`);
      continue;
    }
    const before = counts(extract(beforeText));
    const after = counts(extract(nowText));
    const missing = [...before.keys()].filter((t) => !after.has(t));
    const fewer = [...before.keys()].filter((t) => after.has(t) && after.get(t) < before.get(t));
    const added = [...after.keys()].filter((t) => !before.has(t));
    const skipBefore = skipped(beforeText);
    const newlySkipped = [...skipped(nowText)].filter((t) => !skipBefore.has(t));
    const onlyNow = ONLY_RE.test(nowText) && !ONLY_RE.test(beforeText);

    console.log(`  ${opt.ref}: ${before.size} 条唯一标题 / 现在: ${after.size} 条`);
    console.log(`  消失: ${missing.length} 条${missing.length ? '  ← 逐条要么在新代码里找到对应新标题，要么就是放宽回归' : ''}`);
    missing.forEach((m) => console.log(`    - ${m}`));
    if (fewer.length) {
      console.log(`  出现次数变少: ${fewer.length} 条  ← 同名断言被删掉了几处`);
      fewer.forEach((m) => console.log(`    ~ ${m}  (${before.get(m)} → ${after.get(m)})`));
    }
    if (newlySkipped.length) {
      console.log(`  新增跳过: ${newlySkipped.length} 条  ← 标题还在但不再执行，等同删除`);
      newlySkipped.forEach((m) => console.log(`    ! ${m}`));
    }
    if (onlyNow) console.log('  !! 新出现 .only / fit / fdescribe —— 其余测试全部不会跑');
    if (opt.showAdded && added.length) {
      console.log(`  新增: ${added.length} 条`);
      added.forEach((m) => console.log(`    + ${m}`));
    }
    problems += missing.length + fewer.length + newlySkipped.length + (onlyNow ? 1 : 0);
  }

  console.log(`\nRESULT files=${files.length} problems=${problems}`);
  console.log(problems === 0 ? '结论: 通过（回归没有变松；新增判据是否恒真另用 mutate-check 验）' : '结论: 有消失/减少/跳过，逐条对应后才能放行');
  process.exit(problems === 0 ? 0 : 1);
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

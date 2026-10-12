#!/usr/bin/env node
'use strict';
// 断言/测试标题的机械核对：证明"回归没有变松"。
// 把 <ref> 版本里每条断言的标题抽出来，逐条到当前版本里找；消失的必须逐条有名有姓。
// 人眼读 diff 会漏（改名、挪进循环、拆成两行），脚本不会。
//
// 用法:
//   node audit-assertions.cjs <仓库绝对路径> <相对文件路径[,更多]> [--ref=HEAD]
//                             [--preset=check|test] [--pattern='<JS正则，捕获组1是标题>'] [--show-added]
// 例:
//   node audit-assertions.cjs "D:/proj" "scripts/verify-x.mjs,src/a.test.ts" --preset check
// 退出码: 0 = 没有标题消失；1 = 有消失（需逐条解释）；2 = 用法或环境错误。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRESETS = {
  // 自定义回归框架常见形状：r.check("标题", 期望, 实际)
  check: /r\.check\(\s*\n?\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // jest / vitest / node:test
  test: /\b(?:test|it|describe)\(\s*["'`]([^"'`\n]{2,200})["'`]/g,
};

function parseArgs(argv) {
  const pos = [];
  const opt = { ref: 'HEAD', preset: 'test', pattern: null, showAdded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref' || a === '--preset' || a === '--pattern') {
      opt[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--ref=')) opt.ref = a.slice(6);
    else if (a.startsWith('--preset=')) opt.preset = a.slice(9);
    else if (a.startsWith('--pattern=')) opt.pattern = a.slice(10);
    else if (a === '--show-added') opt.showAdded = true;
    else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
    else pos.push(a.replace(/^"|"$/g, ''));
  }
  if (pos.length < 2) throw new Error('参数不足：需要 <仓库绝对路径> 与 <相对文件路径[,更多]>');
  return { repo: path.resolve(pos[0]), files: pos[1].split(',').map((s) => s.trim()).filter(Boolean), opt };
}

function gitShow(repo, ref, rel) {
  const r = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.error && r.error.message || '').trim().split('\n')[0];
    throw new Error(`git show ${ref}:${rel} 失败 :: ${msg || '退出码 ' + r.status}`);
  }
  return r.stdout;
}

// 标题抽取：正则要带 g，每次重新构造以免 lastIndex 串味
function makeExtractor(presetName, patternStr) {
  if (patternStr) {
    const re = new RegExp(patternStr, 'g');
    return (text) => [...text.matchAll(re)].map((m) => m[1]).filter(Boolean);
  }
  const re = PRESETS[presetName];
  if (!re) throw new Error(`未知 preset ${presetName}，可用：${Object.keys(PRESETS).join('/')}，或用 --pattern`);
  return (text) => [...text.matchAll(new RegExp(re.source, 'g'))].map((m) => m[1]).filter(Boolean);
}

function main() {
  const { repo, files, opt } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(repo)) throw new Error(`仓库路径不存在: ${repo}`);
  const extract = makeExtractor(opt.preset, opt.pattern);
  let totalMissing = 0;

  for (const rel of files) {
    const nowPath = path.join(repo, rel);
    if (!fs.existsSync(nowPath)) {
      console.log(`\n### ${rel}\n  当前文件不存在：${nowPath}`);
      totalMissing++;
      continue;
    }
    const before = extract(gitShow(repo, opt.ref, rel));
    const after = extract(fs.readFileSync(nowPath, 'utf8'));
    const afterSet = new Set(after);
    const beforeSet = new Set(before);
    const missing = [...beforeSet].filter((l) => !afterSet.has(l));
    const added = [...afterSet].filter((l) => !beforeSet.has(l));

    console.log(`\n### ${rel}   (对照 ${opt.ref})`);
    console.log(`  ${opt.ref}: ${beforeSet.size} 条唯一标题 / 现在: ${afterSet.size} 条`);
    console.log(`  消失: ${missing.length} 条${missing.length ? '  ← 逐条要么在新代码里找到对应新标题，要么就是放宽回归' : '（没有标题丢失）'}`);
    missing.forEach((m) => console.log(`    - ${m}`));
    if (opt.showAdded && added.length) {
      console.log(`  新增: ${added.length} 条`);
      added.forEach((m) => console.log(`    + ${m}`));
    }
    // 标题总数不变但条数变了，通常意味着有断言被并进循环 —— 提醒人工看一眼
    if (!missing.length && afterSet.size < beforeSet.size) console.log('  · 注意：唯一标题变少了但没有标题消失，检查是否把多条并成了同一条');
    totalMissing += missing.length;
  }

  console.log(`\n汇总: ${files.length} 个文件, 消失标题 ${totalMissing} 条`);
  console.log(totalMissing === 0 ? '结论: 通过（回归没有变松；仍要人工确认新增的判据不是恒真）' : '结论: 有标题消失，逐条对应对后才能放行');
  process.exit(totalMissing === 0 ? 0 : 1);
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

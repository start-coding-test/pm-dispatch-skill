#!/usr/bin/env node
'use strict';
// 任务卡静态检查：抓占位符残留、缺失小节、缺绝对路径、越界命令。
// 用法: node check-cards.cjs <cards目录或单个.md> [--warn-as-error]

const fs = require('fs');
const path = require('path');

const REQUIRED_SECTIONS = [
  ['背景', /背景/],
  ['目标产出', /目标/],
  ['输入与事实', /输入|事实/],
  ['允许写入路径', /允许写入|可写/],
  ['步骤', /步骤/],
  ['已知坑', /已知坑/],
  ['硬安全边界', /安全边界/],
  ['自检与验收', /自检|验收/],
  ['回传契约', /回传/],
];

const HTML_OK = new Set([
  'br', 'hr', 'img', 'a', 'b', 'i', 'u', 's', 'p', 'div', 'span', 'code', 'pre',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3',
  'http', 'https', 'mailto', 'file',
]);

const FORBIDDEN = [
  [/\bgit\s+(commit|push|checkout|reset|clean|stash|merge|rebase|apply|rm|mv|restore)\b/, '卡片命令含 git 写操作，执行 agent 只允许只读 git'],
  [/\b(pkill|killall)\b/, '按名字杀进程会误杀 IDE 自身进程，禁用'],
  [/taskkill\b[^\n]*\/IM/i, '按映像名杀进程，禁用；只能按 PID + 可执行路径精确停'],
  [/rm\s+-[a-z]*r[a-z]*f\s+["']?[\/\\](?!\w)/i, 'rm -rf 指向根路径'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/, '管道执行远程脚本'],
  [/\b(npm\s+(install|i)\s|pnpm\s+add|yarn\s+add|pip\s+install|cargo\s+install|winget\s+install|choco\s+install)/, '卡片命令里安装依赖，属越界动作'],
];

const RELATIVE_PATH = /(^|[\s"'])((?:\.{1,2}|[A-Za-z0-9_-]+)[/\\][^\s"']+)/;
const NEEDS_ABS = /\b(node|npm|npx|pnpm|python|pip|cargo|pwsh|powershell|bash|sh|curl|wget|tar|7z)\b/;

function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') n++;
  return n;
}

function inSection(text, re) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]) && re.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const findings = [];
  const add = (kind, line, msg, snippet) =>
    findings.push({ kind, line, msg, snippet: (snippet || '').trim().slice(0, 90) });

  // 1. 必需小节
  for (const [label, re] of REQUIRED_SECTIONS) {
    const hasHeading = new RegExp('^#{1,6}[^\\n]*' + re.source, 'm').test(text);
    if (hasHeading) continue;
    if (re.test(text)) add('WARN', 0, `「${label}」没有独立标题，PM 统合时难定位`);
    else add('ERROR', 0, `缺少「${label}」小节`);
  }

  // 2. 阻塞声明
  if (!/Blocked by/i.test(text)) add('ERROR', 0, '缺少 Blocked by 声明（并行调度依赖它）');

  // 3. 模板槽位与 TODO
  for (const m of text.matchAll(/\{\{[^}\n]*\}\}/g)) add('ERROR', lineOf(text, m.index), '模板槽位未替换', m[0]);
  for (const m of text.matchAll(/\b(?:TODO|FIXME|XXX|待填|待定)\b/g)) add('ERROR', lineOf(text, m.index), '残留待填标记', m[0]);

  // 4. 尖括号占位符（执行 agent 会照抄）
  const lines = text.split('\n');
  let fence = false;
  lines.forEach((ln, i) => {
    if (/^\s*```/.test(ln)) { fence = !fence; return; }
    for (const m of ln.matchAll(/<([^>\n]{1,40})>/g)) {
      const inner = m[1];
      const tag = inner.replace(/^\//, '').split(/[\s/]/)[0].toLowerCase();
      if (HTML_OK.has(tag) || /^https?:|^mailto:|^file:|^\/?[a-z]+\/$/.test(inner)) continue;
      if (/^[a-z]+:$/.test(inner)) continue;
      add('ERROR', i + 1, '疑似占位符，执行 agent 会原样照抄', m[0]);
    }
    // 5. 越界命令
    for (const [re, why] of FORBIDDEN) {
      if (re.test(ln)) add('ERROR', i + 1, why, ln);
    }
    // 6. 命令用相对路径
    if ((fence || /^\s*\$ /.test(ln) || /^\s*node\s/.test(ln)) && NEEDS_ABS.test(ln) && RELATIVE_PATH.test(ln) &&
        !/[A-Za-z]:[\\/]/.test(ln) && !/^\s*git\s/.test(ln)) {
      add('WARN', i + 1, '命令用了相对路径，跨 shell 会走错目录', ln);
    }
  });

  // 7. 写入白名单与回传路径必须绝对
  const w = inSection(text, /允许写入|可写/);
  if (w && !/[A-Za-z]:[\\/]/.test(w)) add('ERROR', 0, '「允许写入路径」没有绝对路径');
  const r = inSection(text, /回传/);
  if (r && !/[A-Za-z]:[\\/]/.test(r)) add('ERROR', 0, '「回传契约」的结果文件路径没有绝对路径');
  if (r && !/BLOCKED/.test(r)) add('ERROR', 0, '「回传契约」未声明 BLOCKED 状态（禁反问的出口）');

  return findings;
}

function main() {
  const args = process.argv.slice(2).filter(a => a !== '--warn-as-error');
  const strict = process.argv.includes('--warn-as-error');
  if (!args[0]) {
    console.log('用法: node check-cards.cjs <cards目录或单个.md> [--warn-as-error]');
    process.exit(2);
  }
  let target = args[0].replace(/^"|"$/g, '');
  if (!fs.existsSync(target)) {
    console.log(`ERROR 路径不存在: ${target}`);
    process.exit(2);
  }
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter(f => /\.md$/i.test(f) && !/^_|^README/i.test(f)).map(f => path.join(target, f))
    : [target];

  if (!files.length) {
    console.log(`ERROR 目录里没有 .md 卡片: ${target}`);
    process.exit(2);
  }

  console.log(`扫描 ${files.length} 张卡片`);
  let badFiles = 0, errs = 0, warns = 0;
  for (const f of files) {
    let findings;
    try {
      findings = checkFile(f);
    } catch (e) {
      findings = [{ kind: 'ERROR', line: 0, msg: `读取失败: ${e.message}`, snippet: '' }];
    }
    const fe = findings.filter(x => x.kind === 'ERROR').length;
    const fw = findings.filter(x => x.kind === 'WARN').length;
    errs += fe; warns += fw;
    if (!findings.length) { console.log(`  ${path.basename(f)}  OK`); continue; }
    if (fe) badFiles++;
    console.log(`  ${path.basename(f)}`);
    const shown = findings.slice(0, 25);
    for (const x of shown) {
      console.log(`    ${x.kind.padEnd(5)} ${x.line ? 'L' + x.line : '   '}  ${x.msg}${x.snippet ? ' :: ' + x.snippet : ''}`);
    }
    if (findings.length > shown.length) console.log(`    …还有 ${findings.length - shown.length} 条`);
    console.log(`    => ${fe} error, ${fw} warn`);
  }
  console.log(`汇总: ${files.length} 张卡, ${badFiles} 张需修, ${errs} error, ${warns} warn`);
  console.log(badFiles === 0 && (!strict || warns === 0) ? '结论: 可以派发' : '结论: 修卡后再派发');
  process.exit(badFiles === 0 && (!strict || warns === 0) ? 0 : 1);
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

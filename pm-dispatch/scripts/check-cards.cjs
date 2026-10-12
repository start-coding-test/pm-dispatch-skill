#!/usr/bin/env node
'use strict';
// 任务卡静态门禁：派发前必跑。抓占位符残留、缺小节、缺绝对路径、越界命令、依赖错误、写入路径冲突。
// 用法: node check-cards.cjs <cards目录或单个.md> [--warn-as-error]
// 退出码: 0 可派发 / 1 需修卡 / 2 用法或路径错误
// 跨平台：Windows 盘符、UNC、POSIX 绝对路径都认。

const fs = require('fs');
const path = require('path');
const C = require('./lib/card.cjs');

const REQUIRED_SECTIONS = [
  ['背景', /背景/],
  ['目标产出', /目标/],
  ['输入与事实', /输入|事实/],
  ['允许写入路径', /允许写入|可写/],
  ['步骤', /步骤/],
  ['已知坑', /已知坑/],
  ['硬安全边界', /安全边界/],
  ['自检与验收', /自检|验收标准/],
  ['回传契约', /回传/],
];

// 正常 HTML 标签放行；注意 file 不在里面——<file> 是最典型的占位符
const HTML_OK = new Set([
  'br', 'hr', 'img', 'a', 'b', 'i', 'u', 's', 'p', 'div', 'span', 'code', 'pre', 'kbd', 'sub', 'sup',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'details', 'summary',
]);

const FORBIDDEN = [
  [/\bgit\s+(commit|push|checkout|reset|clean|stash|merge|rebase|apply|rm|mv|restore|switch|cherry-pick|revert)\b/, '卡片命令含 git 写操作，执行 agent 只允许只读 git'],
  [/\b(pkill|killall)\b/, '按名字杀进程会误杀 IDE 自身进程，禁用'],
  [/taskkill\b[^\n]*\/IM/i, '按映像名杀进程，禁用；只能按 PID + 可执行路径精确停'],
  [/Stop-Process\b[^\n]*-Name/i, '按名字停进程，禁用；只能按 PID 精确停'],
  [/rm\s+-[a-z]*r[a-z]*f?\s+["']?(?:[\/\\]|~)(?:\s|["']|$)/i, 'rm -rf 指向根或家目录'],
  [/Remove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:\\?\s*$|\s~)/i, '递归删除盘符根或家目录'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(ba|z)?sh\b|\biex\b[^\n]*\b(iwr|irm|DownloadString)\b/i, '管道执行远程脚本'],
  [/\b(npm\s+(install|i|ci|add|uninstall)\b|pnpm\s+(add|install|i|remove)\b|yarn\s+(add|install|remove)\b|pip3?\s+install|uv\s+(add|pip\s+install)|cargo\s+(install|add)|go\s+get\b|winget\s+install|choco\s+install|brew\s+install|apt(-get)?\s+install)/, '卡片命令里装/卸依赖，属越界动作'],
];

const RELATIVE_PATH = /(^|[\s"'])((?:\.{1,2}|[A-Za-z0-9_-]+)[/\\][^\s"']+)/;
const NEEDS_ABS = /\b(node|npm|npx|pnpm|python3?|py|pip|cargo|go|deno|bun|pwsh|powershell|bash|sh|tar|7z)\b/;

function checkFile(file, ctx) {
  const card = C.parseCard(file);
  const { text, lines } = card;
  const findings = [];
  const add = (kind, line, msg, snippet) =>
    findings.push({ kind, line, msg, snippet: (snippet || '').trim().slice(0, 90) });

  // 1. 必需小节（代码块里的标题不算）
  const hs = C.headings(lines);
  for (const [label, re] of REQUIRED_SECTIONS) {
    if (hs.some((h) => re.test(h.text))) continue;
    if (re.test(text)) add('WARN', 0, `「${label}」没有独立标题，PM 统合时难定位`);
    else add('ERROR', 0, `缺少「${label}」小节`);
  }

  // 2. 卡头字段
  if (card.blockedByRaw === null) add('ERROR', 0, '缺少 Blocked by 声明（调度依赖它；没有就写"无"）');
  else if (ctx.ids) {
    for (const dep of card.blockedBy) {
      if (dep === card.id) add('ERROR', 0, `Blocked by 依赖了自己 :: ${dep}`);
      else if (!ctx.ids.has(dep)) add('WARN', 0, `Blocked by 引用的卡不在本目录 :: ${dep}（确认它已放行，或补卡）`);
    }
  }
  if (!/独占资源|同批互斥/.test(text)) add('WARN', 0, '缺少「独占资源」声明，排批时无法判断能否并行');
  if (!card.level) add('WARN', 0, '缺少「验收等级」（L1/L2/L3），验收强度无从判断');

  // 3. 模板槽位、待填标记、未删的 PM 注释
  for (const l of lines) {
    for (const m of l.text.matchAll(/\{\{[^}\n]*\}\}/g)) add('ERROR', l.no, '模板槽位未替换', m[0]);
    for (const m of l.text.matchAll(/\b(?:TODO|FIXME|TBD|XXX)\b|待填|待定|待补|（待[^）]{0,6}）/g)) add('ERROR', l.no, '残留待填标记', m[0]);
    if (/<!--/.test(l.text)) add('ERROR', l.no, 'PM 注释未删除（执行 agent 会当成指令读）', l.text);
  }

  for (const l of lines) {
    const ln = l.text;
    // 4. 尖括号占位符（代码块里同样抓：命令里的占位符最致命）
    for (const m of ln.replace(/<!--.*?-->/g, '').matchAll(/<([^>\n]{1,40})>/g)) {
      const inner = m[1];
      const tag = inner.replace(/^\//, '').split(/[\s/]/)[0].toLowerCase();
      if (HTML_OK.has(tag) && /^\/?[a-z0-9]+(\s+[a-z-]+=.*)?\/?$/i.test(inner)) continue;
      if (/^(https?|mailto|file):/i.test(inner)) continue;
      if (/^[=\-\s]+$/.test(inner)) continue; // 箭头 <-> <=
      add('ERROR', l.no, '疑似占位符，执行 agent 会原样照抄', m[0]);
    }
    // 5. 越界命令（正文里的禁令引用命令名不算违规；代码块里的照样抓）
    const isProhibition = !l.fence && /(禁止|严禁|不许|不得|不要|禁用|别用)/.test(ln);
    if (!isProhibition && !l.marker) {
      for (const [re, why] of FORBIDDEN) if (re.test(ln)) add('ERROR', l.no, why, ln);
    }
    // 6. 命令用相对路径（同一行已有绝对路径的不报）
    const isCmd = (l.fence && !l.marker) || /^\s*\$ /.test(ln) || /^\s*node\s/.test(ln);
    if (isCmd && NEEDS_ABS.test(ln) && RELATIVE_PATH.test(ln) && !C.hasAbsPath(ln) && !/^\s*git\s/.test(ln)) {
      add('WARN', l.no, '命令用了相对路径，跨 shell 会走错目录', ln);
    }
  }

  // 7. 白名单 / 回传路径必须绝对；回传必须有 BLOCKED 出口；验收必须可勾选
  const w = C.section(lines, /允许写入|可写/);
  if (w && !C.hasAbsPath(w.text)) add('ERROR', 0, '「允许写入路径」没有绝对路径');
  const r = C.section(lines, /回传/);
  if (r && !C.hasAbsPath(r.text)) add('ERROR', 0, '「回传契约」的结果文件路径没有绝对路径');
  if (r && !/BLOCKED/.test(r.text)) add('ERROR', 0, '「回传契约」未声明 BLOCKED 状态（禁反问的出口）');
  if (r && !/不要向用户提问|禁止(向用户)?提问|不要提问/.test(r.text + text)) add('ERROR', 0, '卡片没写"不要向用户提问"，用户会变成人肉翻译层');
  const v = C.section(lines, /自检|验收标准/);
  if (v && !/^\s*[-*]\s*\[[ xX]\]/m.test(v.text)) add('ERROR', 0, '「自检与验收」没有可勾选的验收条目（- [ ] ...）');

  return { card, findings };
}

// 跨卡检查：依赖环、写入白名单重叠却没有依赖关系
function crossCheck(results) {
  const byId = new Map(results.map((r) => [r.card.id, r]));
  const out = [];
  // 依赖环
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 2 || !byId.has(id)) return;
    if (state.get(id) === 1) { out.push(['ERROR', `依赖成环 :: ${[...stack, id].join(' → ')}`]); return; }
    state.set(id, 1);
    for (const d of byId.get(id).card.blockedBy) visit(d, [...stack, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  // 可达性：a 是否（间接）依赖 b
  const dependsOn = (a, b, seen = new Set()) => {
    const r = byId.get(a);
    if (!r || seen.has(a)) return false;
    seen.add(a);
    return r.card.blockedBy.includes(b) || r.card.blockedBy.some((d) => dependsOn(d, b, seen));
  };
  const cards = results.map((r) => r.card);
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      if (dependsOn(a.id, b.id) || dependsOn(b.id, a.id)) continue;
      const hit = a.writes.find((p) => b.writes.some((q) => C.overlap(p, q)));
      if (hit) out.push(['WARN', `${a.id} 与 ${b.id} 的写入白名单重叠且无依赖关系 :: ${hit} —— dispatch.cjs 会让它们串行，确认这是你要的`]);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--warn-as-error');
  const strict = process.argv.includes('--warn-as-error');
  if (!args[0]) {
    console.log('用法: node check-cards.cjs <cards目录或单个.md> [--warn-as-error]');
    process.exit(2);
  }
  const target = args[0].replace(/^"|"$/g, '');
  if (!fs.existsSync(target)) { console.log(`ERROR 路径不存在: ${target}`); process.exit(2); }
  const isDir = fs.statSync(target).isDirectory();
  const files = isDir ? C.listCards(target) : [target];
  if (!files.length) { console.log(`ERROR 目录里没有 .md 卡片: ${target}`); process.exit(2); }

  const ids = isDir ? new Set(files.map((f) => C.parseCard(f).id)) : null;
  console.log(`扫描 ${files.length} 张卡片`);
  let badFiles = 0, errs = 0, warns = 0;
  const results = [];
  for (const f of files) {
    let res;
    try { res = checkFile(f, { ids }); results.push(res); }
    catch (e) { res = { findings: [{ kind: 'ERROR', line: 0, msg: `读取失败: ${e.message}`, snippet: '' }] }; }
    const { findings } = res;
    const fe = findings.filter((x) => x.kind === 'ERROR').length;
    const fw = findings.filter((x) => x.kind === 'WARN').length;
    errs += fe; warns += fw;
    if (!findings.length) { console.log(`  ${path.basename(f)}  OK`); continue; }
    if (fe) badFiles++;
    console.log(`  ${path.basename(f)}`);
    const shown = findings.slice(0, 25);
    for (const x of shown) console.log(`    ${x.kind.padEnd(5)} ${x.line ? ('L' + x.line).padEnd(4) : '    '} ${x.msg}${x.snippet ? ' :: ' + x.snippet : ''}`);
    if (findings.length > shown.length) console.log(`    …还有 ${findings.length - shown.length} 条`);
    console.log(`    => ${fe} error, ${fw} warn`);
  }
  if (isDir && results.length > 1) {
    const cross = crossCheck(results);
    if (cross.length) {
      console.log('  [跨卡]');
      for (const [k, m] of cross) { console.log(`    ${k.padEnd(5)}      ${m}`); if (k === 'ERROR') errs++; else warns++; }
      if (cross.some(([k]) => k === 'ERROR')) badFiles++;
    }
  }
  const ok = badFiles === 0 && (!strict || warns === 0);
  console.log(`汇总: ${files.length} 张卡, ${badFiles} 处需修, ${errs} error, ${warns} warn`);
  console.log(ok ? '结论: 可以派发' : '结论: 修卡后再派发');
  process.exit(ok ? 0 : 1);
}

try { main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exit(2); }

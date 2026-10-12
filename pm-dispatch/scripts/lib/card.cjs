'use strict';
// 卡片解析的公共部分：check-cards.cjs 与 dispatch.cjs 共用，零依赖。
// 关键点：所有"按标题切小节"的逻辑都必须跳过代码块——模板 §9 的回传格式里就嵌着 # / ## 标题。

const fs = require('fs');
const path = require('path');

// 绝对路径：Windows 盘符、UNC、POSIX 根路径（不把 // 注释、URL 当路径）
const ABS_PATH_RE = /(?:^|[\s"'`(（：:])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?![\/\s])[^\s"'`]*)/;

function hasAbsPath(text) {
  return text.split('\n').some((ln) => ABS_PATH_RE.test(ln.replace(/https?:\/\/\S+/g, '')));
}

// 逐行标注是否在 ``` / ~~~ 代码块内（支持 4 个反引号包 3 个反引号的嵌套写法）
function annotate(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null; // 当前打开代码块的围栏串
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = /^\s*(`{3,}|~{3,})/.exec(ln);
    if (m) {
      if (!fence) { fence = m[1]; out.push({ no: i + 1, text: ln, fence: true, marker: true }); continue; }
      if (m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*[`~]+\s*$/.test(ln)) {
        fence = null; out.push({ no: i + 1, text: ln, fence: true, marker: true }); continue;
      }
    }
    out.push({ no: i + 1, text: ln, fence: !!fence, marker: false });
  }
  return out;
}

// 只认代码块之外的标题
function headings(lines) {
  return lines.filter((l) => !l.fence && /^#{1,6}\s/.test(l.text))
    .map((l) => ({ ...l, level: /^(#+)/.exec(l.text)[1].length }));
}

// 取某个小节的全文（直到下一个同级或更高级标题；代码块里的标题不算）
function section(lines, re) {
  const hs = headings(lines);
  const h = hs.find((x) => x.level >= 2 && re.test(x.text)) || hs.find((x) => re.test(x.text));
  if (!h) return null;
  const start = lines.findIndex((l) => l.no === h.no);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.fence && /^#{1,6}\s/.test(l.text) && /^(#+)/.exec(l.text)[1].length <= h.level) { end = i; break; }
  }
  return { heading: h, lines: lines.slice(start, end), text: lines.slice(start, end).map((l) => l.text).join('\n') };
}

// 卡头字段：形如 "- **Blocked by**: T01, T02" 或 "**批次**: 2 | **Blocked by**: 无"
function field(text, name) {
  const re = new RegExp('\\*{0,2}' + name + '\\*{0,2}\\s*[:：]\\s*([^|\\n]*)', 'i');
  const m = re.exec(text);
  return m ? m[1].replace(/\*+/g, '').trim() : null;
}

function idList(v) {
  if (!v || /^(无|none|-|—)$/i.test(v.trim())) return [];
  return v.split(/[,，、\s]+/).map((s) => s.trim()).filter((s) => /^[A-Z]\d+[a-z]?$/.test(s));
}

function cardId(file, text) {
  const fromName = /^([A-Z]\d+[a-z]?)(?=[-_.\s]|$)/.exec(path.basename(file));
  if (fromName) return fromName[1];
  const fromTitle = /^#\s+([A-Z]\d+[a-z]?)\b/m.exec(text);
  return fromTitle ? fromTitle[1] : path.basename(file, '.md');
}

// §4 白名单里的路径（"禁止"那一段之前，反引号包住的部分）
function writePaths(lines) {
  const s = section(lines, /允许写入|可写/);
  if (!s) return [];
  const allow = s.text.split(/\*\*禁止\*\*|^禁止/m)[0];
  return [...allow.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((p) => ABS_PATH_RE.test(' ' + p));
}

function normPath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 两个白名单是否重叠：同一路径，或一方是另一方的父目录
function overlap(a, b) {
  const x = normPath(a), y = normPath(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

function parseCard(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.replace(/^\uFEFF/, '');
  const lines = annotate(text);
  const head = text.split(/\n##\s/)[0];
  const exclusive = (field(head, '独占资源') || field(head, '同批互斥') || '').trim();
  return {
    file,
    id: cardId(file, text),
    title: ((/^#\s+(.+)$/m.exec(text) || [])[1] || '').trim(),
    type: (field(head, '卡型') || cardId(file, text)[0] || '').trim(),
    blockedBy: idList(field(head, 'Blocked by')),
    blockedByRaw: field(head, 'Blocked by'),
    exclusive: /^(无|none|-|—)/i.test(exclusive) || !exclusive ? [] :
      exclusive.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean),
    level: ((field(head, '验收等级') || '').match(/L[123]/) || [null])[0],
    writes: writePaths(lines),
    text,
    lines,
  };
}

function listCards(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /\.md$/i.test(f) && !/^_|^(?:README|SKILL)\./i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

module.exports = { ABS_PATH_RE, hasAbsPath, annotate, headings, section, field, idList, parseCard, listCards, overlap, normPath };

#!/usr/bin/env node
'use strict';
// 四个脚本的自测：在临时目录（路径里故意带空格）造卡片、台账、小仓库，逐项断言退出码与关键输出。
// 用法: node tests/selftest.cjs      退出码 0 = 全过
// 需要本机有 git（audit-assertions 依赖它）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.join(__dirname, '..', 'pm-dispatch');
const S = path.join(SKILL, 'scripts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pm dispatch selftest '));
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${name}${detail ? '\n' + detail.split('\n').map((l) => '     | ' + l).join('\n') : ''}`); }
}
function run(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(S, script), ...args], { encoding: 'utf8', ...opts });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function sh(cmd, args, cwd) { return spawnSync(cmd, args, { cwd, encoding: 'utf8' }); }

// ---------- 卡片 ----------
const TEMPLATE = fs.readFileSync(path.join(SKILL, 'assets', 'card-template.md'), 'utf8');
const D = path.join(ROOT, '.dispatch', 'demo');
const CARDS = path.join(D, 'cards');
fs.mkdirSync(CARDS, { recursive: true });

function makeCard(id, { deps = '无', excl = '无', writes, base = ROOT, keepComment = false, extra = '' }) {
  let t = TEMPLATE;
  if (!keepComment) t = t.replace(/<!--[\s\S]*?-->\n/g, '');
  t = t.replace(/\{\{卡号\}\}/g, id)
    .replace(/\*\*Blocked by\*\*: \{\{[^}]*\}\}/, `**Blocked by**: ${deps}`)
    .replace(/\*\*独占资源\*\*: \{\{[^}]*\}\}/, `**独占资源**: ${excl}`)
    .replace(/\*\*验收等级\*\*: \{\{[^}]*\}\}/, '**验收等级**: L2')
    .replace(/\{\{若本卡要改源码[^}]*\}\}/, `\`${writes}\` 只许动这些`)
    .replace(/\{\{[^}\n]*\}\}/g, path.join(base, 'x'));
  return t.replace('## 1. 背景\n', '## 1. 背景\n' + extra);
}

const src = (f) => path.join(ROOT, 'src', f);
fs.writeFileSync(path.join(CARDS, 'T01-a.md'), makeCard('T01', { writes: path.join(ROOT, 'docs', 't01.md') }));
fs.writeFileSync(path.join(CARDS, 'A02-b.md'), makeCard('A02', { deps: 'T01', excl: 'gui', writes: src('b.ts') }));
fs.writeFileSync(path.join(CARDS, 'A03-c.md'), makeCard('A03', { deps: 'T01', excl: 'gui', writes: src('c.ts') }));
fs.writeFileSync(path.join(CARDS, 'B04-d.md'), makeCard('B04', { deps: 'A02, A03', writes: 'D:\\proj\\src\\d.ts', base: 'D:\\proj' }));

let r = run('check-cards.cjs', [CARDS]);
check('填好的模板（POSIX 与 Windows 路径混用）能过门禁', r.rc === 0, r.out);

const BAD = path.join(ROOT, 'bad');
fs.mkdirSync(BAD);
fs.writeFileSync(path.join(BAD, 'T09-x.md'), makeCard('T09', { deps: 'T09', writes: src('x.ts'), keepComment: true, extra: '这里待填，参考 <file>\n```\nnpm install lodash\ngit commit -am done\n```\n' }));
r = run('check-cards.cjs', [BAD]);
check('坏卡被拦下', r.rc === 1, r.out);
for (const [what, needle] of [['中文待填', '残留待填标记 :: 待填'], ['尖括号占位符 file', '<file>'], ['PM 注释', 'PM 注释未删除'],
  ['装依赖', '装/卸依赖'], ['git 写', 'git 写操作'], ['依赖自己', '依赖了自己']]) {
  check(`坏卡：抓到${what}`, r.out.includes(needle), r.out);
}

// 依赖环
const CYC = path.join(ROOT, 'cyc');
fs.mkdirSync(CYC);
fs.writeFileSync(path.join(CYC, 'T01-a.md'), makeCard('T01', { deps: 'T02', writes: src('1.ts') }));
fs.writeFileSync(path.join(CYC, 'T02-b.md'), makeCard('T02', { deps: 'T01', writes: src('2.ts') }));
r = run('check-cards.cjs', [CYC]);
check('依赖成环被拦下', r.rc === 1 && r.out.includes('依赖成环'), r.out);

// ---------- 调度 ----------
fs.writeFileSync(path.join(D, 'ledger.md'), [
  '# 台账：demo', '并发上限 2', '',
  '| 卡 | 标题 | 状态 | 验收 |', '|----|------|------|------|',
  '| T01 | a | 已回 | PASS：重跑复现 |', '| A02 | b | 待派 | |', '',
].join('\n'));
r = run('dispatch.cjs', ['status', D]);
check('status：T01 放行后 A02 可派', /现在可派: A02\b/.test(r.out), r.out);
check('status：A03 因 gui 独占被暂缓', /暂缓 A03：.*独占资源 gui/.test(r.out), r.out);
check('status：B04 等前置', /B04\s+待派\s+依赖 A02,A03\s+等 A02,A03/.test(r.out), r.out);
r = run('dispatch.cjs', ['run', D, '--exec', `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '# ok')" %RESULT%`]);
check('run：拉起执行器并写出结果文件', r.rc === 0 && fs.existsSync(path.join(D, 'results', 'A02.md')), r.out);
r = run('dispatch.cjs', ['next', D]);
check('next：重派时旧结果改名为 retry1', fs.existsSync(path.join(D, 'results', 'A02.md.retry1')), r.out);
check('next：启动语含禁反问', r.out.includes('不要向用户提问'), r.out);
r = run('dispatch.cjs', ['next', D, '--agent', 'pm-executor']);
check('next --agent：派发指令点名子代理并行启动', r.rc === 0 && r.out.includes('并行启动 1 个 pm-executor 子代理') && r.out.includes('=== A02 ===') && r.out.includes('不要向用户提问'), r.out);
r = run('dispatch.cjs', ['next', D, '--agent', 'bad name;rm']);
check('next --agent：非法子代理名在动手前就拒绝', r.rc === 2 && r.out.includes('子代理名只能含') && !r.out.includes('已写入'), r.out);

// ---------- 执行子代理模板 ----------
const EX = path.join(SKILL, 'assets', 'executors');
const exPrompt = fs.readFileSync(path.join(EX, 'executor-prompt.md'), 'utf8').trim();
for (const [f, nameRe] of [['qoder/pm-executor.md', /^name: pm-executor$/m], ['zcode/pm-executor.md', /^name: pm-executor$/m], ['codex/pm-executor.toml', /^name = "pm_executor"$/m]]) {
  const t = fs.readFileSync(path.join(EX, f), 'utf8');
  check(`子代理模板 ${f}：名字正确、钉了模型（不是 inherit）`, nameRe.test(t) && /^model\s*[:=]\s*"?REPLACE_WITH_FLASH_MODEL"?$/m.test(t) && !/inherit/.test(t.replace(/^#.*$/gm, '')), t.slice(0, 400));
  check(`子代理模板 ${f}：系统提示词与 executor-prompt.md 一致`, t.includes(exPrompt));
}

// ---------- 变异抽查 ----------
const REPO = path.join(ROOT, 'repo');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'tests'), { recursive: true });
const RULES = 'exports.limit = (c) => { if (c.startsWith("92")) return 30; return 10; };\r\nexports.cost = (x) => x * 2 + 0;\r\n';
fs.writeFileSync(path.join(REPO, 'src', 'rules.js'), '\uFEFF' + RULES); // BOM + CRLF：验证逐字节还原
fs.writeFileSync(path.join(REPO, 'tests', 'unit.js'), [
  "const r = require('../src/rules.js'); let fail = 0;",
  'function check(n, g, w) { if (g !== w) { fail++; console.log(`FAIL ${n} :: got ${g} want ${w}`); } }',
  'check("北交所给 30", r.limit("920185"), 30);',
  'check("主板给 10", r.limit("600000"), 10);',
  'check("cost 是数字", typeof r.cost(1), "number");',
  'console.log(`RESULT pass=${3 - fail} fail=${fail}`); process.exit(fail ? 1 : 0);',
].join('\n'));
const before = fs.readFileSync(path.join(REPO, 'src', 'rules.js'));
const plan = path.join(ROOT, 'plan.json');
const unit = `node "${path.join(REPO, 'tests', 'unit.js')}"`;
fs.writeFileSync(plan, JSON.stringify({ repo: REPO, timeout: 5, cases: [
  { id: 'M1', file: 'src/rules.js', from: 'if (c.startsWith("92")) return 30;', to: '', cmd: unit, expect: '北交所' },
  { id: 'M2', file: 'src/rules.js', from: 'x * 2 + 0', to: 'x * 3', cmd: unit },
  { id: 'M3', file: 'src/rules.js', from: 'return 10;', to: 'while (true) {}', cmd: unit },
  { id: 'M4', file: 'src/rules.js', from: 'x * 2', to: '$&$&', cmd: unit },
  { id: 'M5', file: 'src/rules.js', from: 'nope', to: 'x', cmd: unit },
] }));
r = run('mutate-check.cjs', ['--plan', plan]);
check('mutate：M1 杀掉', /M1\s+杀掉（断言有效）/.test(r.out), r.out);
check('mutate：M2 存活（恒真断言）', /M2\s+没杀掉/.test(r.out), r.out);
check('mutate：M3 死循环按超时杀掉', /M3\s+杀掉（超时/.test(r.out), r.out);
check('mutate：M4 崩溃不算有效杀掉，且 $& 按字面替换', /M4\s+红了但是崩溃/.test(r.out), r.out);
check('mutate：M5 锚点无效记 SKIP', /M5\s+SKIP/.test(r.out), r.out);
check('mutate：退出码 1 + RESULT 行', r.rc === 1 && /RESULT cases=5 killed=2 survived=1 wrong_kill=1 skipped=1/.test(r.out), r.out);
check('mutate：BOM + CRLF 文件逐字节还原', fs.readFileSync(path.join(REPO, 'src', 'rules.js')).equals(before));
check('mutate：备份目录已清理', !fs.existsSync(path.join(REPO, 'temp')) || fs.readdirSync(path.join(REPO, 'temp')).length === 0);

fs.writeFileSync(path.join(ROOT, 'plan-red.json'), JSON.stringify({ repo: REPO, cases: [
  { id: 'M1', file: 'src/rules.js', from: 'return 10;', to: 'return 11;', cmd: `node -e "process.exit(1)"` }] }));
r = run('mutate-check.cjs', ['--plan', path.join(ROOT, 'plan-red.json')]);
check('mutate：基线不绿直接中止（退出码 2）', r.rc === 2 && r.out.includes('基线就不绿'), r.out);

// ---------- 断言核对 ----------
const hasGit = sh('git', ['--version']).status === 0;
if (hasGit) {
  sh('git', ['init', '-q'], REPO);
  fs.writeFileSync(path.join(REPO, 'tests', 'a.test.js'), 'test("alpha", f); test("beta", f); test("beta", f); it("gamma", f);\n');
  sh('git', ['add', '-A'], REPO);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], REPO);
  r = run('audit-assertions.cjs', [REPO, 'tests/a.test.js']);
  check('audit：未改动时通过', r.rc === 0, r.out);
  fs.writeFileSync(path.join(REPO, 'tests', 'a.test.js'), 'test("alpha", f); test("beta", f); it.skip("gamma", f); test("delta", f);\n');
  fs.writeFileSync(path.join(REPO, 'tests', 'b.test.js'), 'test("new one", f);\n');
  r = run('audit-assertions.cjs', [REPO, 'tests/a.test.js,tests/b.test.js', '--show-added']);
  check('audit：抓到同名断言次数变少', r.out.includes('~ beta  (2 → 1)'), r.out);
  check('audit：抓到新增 .skip', r.out.includes('! gamma'), r.out);
  check('audit：新文件不报错', r.out.includes('新文件'), r.out);
  check('audit：退出码 1', r.rc === 1, r.out);
} else {
  console.log('SKIP audit-assertions：本机没有 git');
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

# pm-dispatch

一个 Agent Skills 格式的技能：让**主会话担任项目经理**，把简单但耗时的机械任务写成自包含任务卡，成批并行派发给轻量执行模型（flash 档），结果落盘后由主会话验收、打回和统合。可在 Qoder CLI、ZCode、Codex 等支持 `SKILL.md` 的客户端里使用。

An Agent-Skills-format skill that turns the main session into a project manager: it writes self-contained task cards for cheap/fast execution models to run in parallel, then reviews, rejects, and integrates their output. Works in any client that loads `SKILL.md` skills.

## 它解决的问题

| 交接失败模式 | 本技能的对策 |
|---|---|
| 执行 agent 看不到主会话的对话上下文 | 卡片十节强制包含背景、输入事实、允许写入路径 |
| 弱模型照抄 `<owner>`、`{{路径}}` 这类槽位 | 派发前用 `scripts/check-cards.cjs` 静态门禁，有 error 不许派发 |
| 多个任务并行写同一文件互相覆盖 | 一卡一 `work\Txx\` 目录 + 白名单 + 排批时按"独占资源/同文件"互斥 |
| 执行 agent 把"没做到"汇报成"已完成" | 验收命令由主会话亲自重跑，用真实输出判定 PASS/FAIL |
| 回归脚本被静默改松（删断言、改名、调大上限凑绿） | `scripts/audit-assertions.cjs` 机械核对旧版本里每条断言标题是否还在 |
| 断言全绿但其实什么都不判（恒真） | `scripts/mutate-check.cjs` 把代码逐点改坏，看断言会不会红；不红即打回 |
| 卡片写了物理上做不到的判据 | SKILL.md「四条铁律」要求下发前自问"这条能成立吗" |
| 一批改动让后续卡片引用的行号失效 | 「基线纪律」：每批放行后立刻更新矩阵数字与下一批卡的 `文件:行号` |
| 删掉旧入口的卡排在前面，替代入口排在最后 | 排批规则第 4 条：删入口必须与替代入口同批或更晚 |
| 一个 agent 把同工作树里另一个 agent 的未提交改动回滚掉 | 卡片硬安全边界明写"禁止回滚不属于本卡的改动" |
| GUI 验收被权限分类器拦住，一卡白跑 | 「权限现实」：卡片写清前置命令，拦住不重试，改成用户起实例 / PM 只跑套件 |
| 用户变成两个 agent 之间的人肉翻译层 | 卡片写明「不要提问，卡片没覆盖的记 BLOCKED 后停止」 |

**分工原则**：判断留在主会话（架构、术语、验收标准、不可逆操作），执行外派出去（批量改写、数据收集、补测试、逐文件迁移）。

## 安装

把 `pm-dispatch/` 整个目录放进 Qoder 的技能目录：

把 `pm-dispatch/` 整个目录拷进任一技能根（格式是同一套 Agent Skills 规范：`SKILL.md` + `scripts/` + `references/` + `assets/`，`name` 等于目录名）：

| 客户端 | 用户级根 | 项目级根 |
|---|---|---|
| 跨工具通用位置 | `~/.agents/skills/` | `<project>/.agents/skills/` |
| Qoder CLI | `~/.qoder-cn/skills/` | `<project>/.qoder/skills/` |
| ZCode | `~/.zcode/skills/` | `<project>/.zcode/skills/` |
| Codex | `~/.codex/skills/` | — |

Windows 上 `~` 即 `C:\Users\<你的用户名>`。装完重启会话或 `/skills reload`，用 `/pm-dispatch <功能名>` 调用。

同一份内容在多个根里同时存在会被重复发现，挑一个根装即可（默认建议 `~/.agents/skills/`）。

## 跨客户端

不依赖任何单一客户端的专有能力——没用到子代理、没用到 MCP，全流程只是文件读写加一条 Node 命令。任务卡的交接契约也只是"卡片文件 + 结果文件 + 一段可粘贴启动语"，所以主会话和执行方可以是**不同客户端**：Qoder 当 PM、ZCode 里的轻量模型执行，反过来也行。

唯一外部依赖是本机有 Node（跑 `scripts/check-cards.cjs`）。frontmatter 只保留 `name` 和 `description` 两个字段，以兼容各家对保留字段的规范差异。

技能根的定位写在 SKILL.md 的门禁命令里，按 `~/.agents` → `~/.qoder-cn` → `~/.zcode` → `~/.codex` 顺序探测，不写死单一安装目录。

## 触发方式

除了斜杠命令，说这些话也会命中：

> 这些活排给我，我拿去派 flash ／ 你只当 PM 别自己写 ／ 把任务写成卡并行跑 ／ T03 跑完了，帮我验收 ／ 这批太机械了外包掉

## 运行时工作区

技能会在项目根创建 `.dispatch/<功能名>/`：

```
.dispatch/登录功能/
├── ledger.md              PM 台账，唯一进度事实源（只有主会话写）
├── cards/T01-schema.md     任务卡（只有主会话写，执行 agent 禁改）
├── results/T01.md          执行结果（只有对应执行 agent 写）
└── work/T01/               该卡唯一可写区
```

派发时主会话给每张卡输出一段可直接复制的启动语，指向卡片的绝对路径；你把这段贴进执行模型的会话即可，多张卡并行。

## 卡片门禁

`scripts/check-cards.cjs` 检查：占位符残留、必需小节缺失、`Blocked by` 缺失、写入与回传路径未用绝对路径、命令里出现 git 写操作 / 按名字杀进程 / 安装依赖 / 管道执行远程脚本。

```
$ S="$(ls -d "$HOME/.agents/skills/pm-dispatch" "$HOME/.qoder-cn/skills/pm-dispatch" "$HOME/.zcode/skills/pm-dispatch" "$HOME/.codex/skills/pm-dispatch" 2>/dev/null | head -1)"
$ node "$S/scripts/check-cards.cjs" "<项目绝对路径>\.dispatch\demo\cards"
扫描 2 张卡片
  T01-clean.md  OK
  T02-dirty.md
    ERROR      缺少「允许写入路径」小节
    ERROR      缺少「已知坑」小节
    ERROR      缺少「硬安全边界」小节
    ERROR      缺少 Blocked by 声明（并行调度依赖它）
    ERROR L1  模板槽位未替换 :: {{任务标题}}
    ERROR L5  疑似占位符，执行 agent 会原样照抄 :: <owner>
    WARN  L19  命令用了相对路径，跨 shell 会走错目录 :: node scripts/shot.cjs --out out/
    ERROR L20  卡片命令含 git 写操作，执行 agent 只允许只读 git :: git commit -am "done"
    …还有 5 条
    => 12 error, 1 warn
汇总: 2 张卡, 1 张需修, 12 error, 1 warn
结论: 修卡后再派发
```

（上面是真实输出，中间用 `…还有 5 条` 处省略了几行。）

加 `--warn-as-error` 可让相对路径告警也拦下派发。退出码：0 可派发 / 1 需修卡 / 2 用法或路径错误。

## 验收工具（两个新脚本）

技能原本只有"派发前"的门禁，缺"回传后"的手段。这两个把 PM 验收里最容易被糊弄的两步变成可跑的命令。

**1. 回归没有变松** —— 旧版本里每条断言/测试标题，逐条到当前版本里找：

```
$ node "$S/scripts/audit-assertions.cjs" "D:/proj" "scripts/verify-x.mjs,src/a.test.ts" --preset check --ref HEAD --show-added
### scripts/verify-x.mjs   (对照 HEAD)
  HEAD: 155 条唯一标题 / 现在: 157 条
  消失: 1 条  ← 逐条要么在新代码里找到对应新标题，要么就是放宽回归
    - 五档来自腾讯（与快照是同一条接口的两段）
  新增: 3 条
    + 五档源符合本轮可用性（非首选源必须有失败记录解释）
汇总: 2 个文件, 消失标题 1 条
结论: 有标题消失，逐条对应对后才能放行
```

`--preset check` 适配自定义 `r.check("标题", …)`，`--preset test` 适配 jest/vitest/node:test，
自家形状用 `--pattern='…(捕获组1是标题)…'`。退出码：0 无标题消失 / 1 有消失 / 2 用法错。

**2. 断言不是恒真** —— 表驱动的变异抽查，在备份保护下把代码逐点改坏：

```
// D:/proj/temp/mutate-plan.json
{ "repo": "D:/proj",
  "cases": [
    { "id": "M1", "file": "src/parser.js", "from": "if (c.startsWith(\"92\")) return 30;", "to": "", "cmd": "node tests/unit.mjs" },
    { "id": "M2", "file": "src/rules.js",  "from": "up !== null && price >= up - 1e-6", "to": "true", "cmd": "node tests/unit.mjs" }
  ] }
```
```
$ node "$S/scripts/mutate-check.cjs" --plan "D:/proj/temp/mutate-plan.json" --baseline
用例 2 个、涉及文件 2 个 → 备份在 D:\proj\temp\mutate-check-20261012T073938
基线（未变异）:
  node tests/unit.mjs  → rc=0 RESULT pass=4 fail=0
M1  杀掉（断言有效）  rc=1 RESULT pass=3 fail=1
     ↳ FAIL 北交所 920185 给 30 :: got 10 want 30
M2  没杀掉（恒真/覆盖不足）  rc=0 RESULT pass=4 fail=0
还原校验：2 个文件逐字节一致
结论: 1 个变异没被杀掉（其中锚点无效 0 个）—— 补断言、修锚点，或打回
```

要点：一次只改一个点；`from` 必须唯一命中（不唯一直接 SKIP 并计为未验证）；
结束自动还原并逐字节校验，所以**未跟踪的新文件也不会丢**（不靠 `git checkout`）。
`--keep-backup` 保留备份目录。退出码：0 全杀掉 / 1 有漏网或锚点无效 / 2 用法或还原失败。

## 在构建链中的位置

```
grill-with-docs → to-spec → to-tickets ─┬─ 判断类 → implement → code-review
                                        └─ 机械耗时类 → pm-dispatch → code-review
```

`pm-dispatch` 与 `implement` 是并列的两条执行路线，同一批任务可以一半自留一半外派。

## 内容

```
pm-dispatch/
├── SKILL.md                        角色边界、分诊表、卡型、写卡→排批→验收→统合→基线→台账
├── assets/card-template.md         十节任务卡模板：批次互斥声明、红→绿对照、状态词表、RESULT 机器行、打回 §10 的结构
├── references/acceptance.md        验收手法手册：三查具体化、机械核对/变异抽查、现场红的五类分法、打回卡怎么写
├── references/known-pitfalls.md    踩坑库（Shell/Node/权限/进程/断言与判据/取证卡写法/同工作树多卡/Git/目录卫生/弱模型特征）
└── scripts/
    ├── check-cards.cjs             派发前静态门禁：占位符、缺小节、越界命令、非绝对路径
    ├── audit-assertions.cjs        回传后核对：旧版每条断言标题是否还在（回归有没有变松）
    └── mutate-check.cjs            回传后核对：把代码改坏看点不红（断言是不是恒真）
```

## 变更（v2，来自一轮真实派发）

一轮 10 张卡跑下来，返工的原因几乎都不在"执行者能力差"，而在 PM 侧的四个缺口，本版逐条补上：

- **验收只有"重跑"这一招** → 补 `references/acceptance.md` 与两个脚本：机械核对断言标题、变异抽查证明非恒真、
  `文件:行号` 抽样对原文；并给出"现场红的五类分法"（代码红/断言红/判定输入红/环境红/时序红），
  只有第一类该打回执行卡。
- **卡片判据没验过"能不能做到"** → 铁律加一条，并收了三条真实反例（文案长度超出容器容量、
  要求序列化后"逐字节未变"、把同意框触发时机钉死成"首次调用"）。
- **排批只看依赖不看独占资源** → 排批规则四条：独占型资源互斥、同文件互斥、离线卡才是并行位、
  **删入口的卡必须与替代入口同批或更晚**。
- **跨批次会烂的东西没人管** → 新增「基线纪律」（运行数下限、行号漂移、外部可用性不是代码属性）
  与「权限现实」（谁起 GUI 实例、拦住不重试、PM 未复跑必须单独记一节）。
- **执行者反过来纠正 PM 是常态** → 新增处置规矩：复现后采纳，并回改到源头（卡片 + 规格 + 约定表）。

## 来源与署名

- 本技能为原创，但流程衔接 Qoder 插件市场的 `grillme-matt`（`to-tickets` / `implement` / `code-review` / `dev-router`）构建链，术语与该插件保持一致。
- 该插件自带的来源说明只写了它自己的源目录，**未标注上游 skill 的原作者**，因此这里不做进一步署名断言。若你知道原始出处，欢迎提 Issue 补充。
- 卡片模板中「示踪弹 / 垂直切片」的任务切分理念沿用 `to-tickets` 的输出格式。

## License

MIT — 见 [LICENSE](LICENSE)。

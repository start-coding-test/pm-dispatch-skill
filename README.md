# pm-dispatch

一个 Qoder CLI skill：让**主会话担任项目经理**，把简单但耗时的机械任务写成自包含任务卡，成批并行派发给轻量执行模型（flash 档），结果落盘后由主会话验收、打回和统合。

A Qoder CLI skill that turns the main session into a project manager: it writes self-contained task cards for cheap/fast execution models to run in parallel, then reviews, rejects, and integrates their output.

## 它解决的问题

| 交接失败模式 | 本技能的对策 |
|---|---|
| 执行 agent 看不到主会话的对话上下文 | 卡片十节强制包含背景、输入事实、允许写入路径 |
| 弱模型照抄 `<owner>`、`{{路径}}` 这类槽位 | 派发前用 `scripts/check-cards.cjs` 静态门禁，有 error 不许派发 |
| 多个任务并行写同一文件互相覆盖 | 一卡一 `work\Txx\` 目录 + 一结果文件，写入面白名单锁死 |
| 执行 agent 把"没做到"汇报成"已完成" | 验收命令由主会话亲自重跑，用真实输出判定 PASS/FAIL |
| 用户变成两个 agent 之间的人肉翻译层 | 卡片写明「不要提问，卡片没覆盖的记 BLOCKED 后停止」 |

**分工原则**：判断留在主会话（架构、术语、验收标准、不可逆操作），执行外派出去（批量改写、数据收集、补测试、逐文件迁移）。

## 安装

把 `pm-dispatch/` 整个目录放进 Qoder 的技能目录：

- 用户级（所有项目可用）：`C:\Users\<你的用户名>\.qoder-cn\skills\pm-dispatch\`
- 项目级（仅当前项目）：`<项目根>\.qoder\skills\pm-dispatch\`

然后重启会话或执行 `/skills reload`，用 `/pm-dispatch <功能名>` 调用。

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
$ node "$HOME/.qoder-cn/skills/pm-dispatch/scripts/check-cards.cjs" "<项目绝对路径>\.dispatch\demo\cards"
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

## 在构建链中的位置

```
grill-with-docs → to-spec → to-tickets ─┬─ 判断类 → implement → code-review
                                        └─ 机械耗时类 → pm-dispatch → code-review
```

`pm-dispatch` 与 `implement` 是并列的两条执行路线，同一批任务可以一半自留一半外派。

## 内容

```
pm-dispatch/
├── SKILL.md                       角色边界、分诊表、写卡→派发→验收→统合→台账五段流程
├── assets/card-template.md        十节任务卡模板，含结果文件回传格式
├── references/known-pitfalls.md   踩坑库（Windows/Node/进程/Git/目录卫生/弱模型行为特征）
└── scripts/check-cards.cjs        派发前静态门禁，零依赖 Node
```

## 来源与署名

- 本技能为原创，但流程衔接 Qoder 插件市场的 `grillme-matt`（`to-tickets` / `implement` / `code-review` / `dev-router`）构建链，术语与该插件保持一致。
- 该插件自带的来源说明只写了它自己的源目录，**未标注上游 skill 的原作者**，因此这里不做进一步署名断言。若你知道原始出处，欢迎提 Issue 补充。
- 卡片模板中「示踪弹 / 垂直切片」的任务切分理念沿用 `to-tickets` 的输出格式。

## License

MIT — 见 [LICENSE](LICENSE)。

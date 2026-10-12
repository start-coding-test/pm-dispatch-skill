# 执行子代理：一次配置，之后不再人肉搬运

目标：主会话用大模型（Max）当 PM，执行者是**钉死在 flash 档模型上的自定义子代理** `pm-executor`。
PM 跑 `dispatch.cjs next --agent pm-executor`，把打印出的派发指令交给自己的子代理工具即可，用户不用开会话、不用复制启动语。

模板在 `assets/executors/`，三份共用同一段系统提示词 `executor-prompt.md`（改提示词时三份一起改，自测会核对）。

## 1. 安装（每个 harness 一次）

| Harness | 复制 | 到 | 子代理名 |
|---|---|---|---|
| Qoder CLI / IDE | `assets/executors/qoder/pm-executor.md` | 项目级 `.qoder/agents/`，或用户级 `~/.qoder/agents/`（Qoder CN 版为 `~/.qoder-cn/agents/`） | `pm-executor` |
| ZCode | `assets/executors/zcode/pm-executor.md` | `~/.zcode/agents/`（目前只支持用户级） | `pm-executor` |
| Codex | `assets/executors/codex/pm-executor.toml` | 用户级 `~/.codex/agents/`，或项目级 `.codex/agents/` | `pm_executor` |

然后把文件里的 `REPLACE_WITH_FLASH_MODEL` 换成你账号里 flash 档的模型：

- **Qoder CLI**：档位名，`qodercli --list-models` 查；IDE 里也可以在 设置 → Agents → Change Model 直接选。
- **ZCode**：具体模型 ID，在 设置 → 子智能体 → 新建 的模型下拉里看。**不要写 `inherit`**。思考强度字段叫 `thoughtLevel`，写成别的名字会被静默忽略。
- **Codex**：模型 ID（`/model` 看列表），`model_reasoning_effort` 按该模型支持的档位调。

占位符不换会直接报错——这是故意的，宁可失败也不要悄悄继承主会话的大模型。

生效：Qoder 跑 `/agents reload` 或开新会话；ZCode、Codex 都要**新开会话**才会加载。

## 2. 首次验证（必做，每个 harness 一次）

1. 用一张只读 T 卡，`dispatch.cjs next 目录 --agent pm-executor`（Codex 写 `pm_executor`），把打印的派发指令交给主会话的子代理工具。
2. 确认子代理列表里出现的是 `pm-executor`，不是 general-purpose / default。
3. **确认它真的跑在 flash 上**：看客户端的用量统计或子代理线程里的模型名（Codex 可查 `~/.codex/sessions/` 里子线程的 `turn_context.model`）。
4. 结果文件按回传契约写出、PM 能验收，才算通过。之后整批切到子代理方式。

## 3. 已知坑

- **Codex 无头模式**：`codex exec` 下自定义 agent 文件里的 `model` 曾被忽略、子代理继承父会话模型（openai/codex#33881）。用交互式会话派卡；要走无头就用 `dispatch.cjs run --exec`，在命令模板里直接写 `codex exec -m <flash 模型>`，不经过子代理。
- **Codex 只在被明确要求时才起子代理**：派发指令里已写明"并行启动 N 个子代理"，别删。
- **ZCode 前台子代理会阻塞主任务**直到全部返回；一轮派太多卡，最慢的一张拖住 PM。并发上限按 ledger 的设置，别临时加大。
- **ZCode 子代理里不能再派子代理**；Qoder 模板用 `disallowedTools: [Agent]` 禁掉了嵌套。
- **权限继承父会话**：Codex 子代理继承父会话的沙箱/审批选择；Qoder 父会话已是 acceptEdits/bypass 时子代理不能更严。需要 GUI 或交互授权的卡仍走人工启动语。
- **共享工作树**：子代理和 PM 在同一个工作树里写文件，安全边界仍是写入白名单 + 调度器的冲突检查。不要为了"更快"绕过 `dispatch.cjs`。
- **子代理返回的只是一行状态**：它说 DONE 不等于通过。验收照旧读 `results/卡号.md`，按 L1/L2/L3 做，然后更新台账。

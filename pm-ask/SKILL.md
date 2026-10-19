---
name: pm-ask
description: 执行 agent（子 agent）主动呼叫 Notion 里的云端项目经理（协议 v2）。按任务卡干活时——新卡开工/里程碑/申请合并/卡住/合并后回报/事故——用对应子命令把 #R-* 汇报发给云端 PM，拿回 #D-* 决策后照做。只在功能目录 .dispatch/功能名/ 下有 cloud-pm.json 时可用。与 pm-dispatch 配套：pm-dispatch 给主会话 PM 用，本技能给执行者用。
---

# 呼叫云端 PM（pm-ask · 协议 v2）

你是执行者，不是 PM。这个技能只做一件事：在规定时机运行 `scripts/pm-ask.cjs`，把协议 v2 规定的 `#R-*` 汇报发给 Notion 里的云端 PM，拿回 `#D-*` 决策后**在任务卡允许的范围内**继续。

先定位本技能根（不写死安装目录）：

```
P="$(ls -d "$HOME/.agents/skills/pm-ask" "$HOME/.qoder-cn/skills/pm-ask" "$HOME/.zcode/skills/pm-ask" "$HOME/.codex/skills/pm-ask" "$HOME/.claude/skills/pm-ask" .agents/skills/pm-ask .claude/skills/pm-ask 2>/dev/null | head -1)"
```

任务卡里如果已经写了 pm-ask 的绝对路径，以卡片为准。

## 前提

- 功能目录 `.dispatch/功能名/` 下有 `cloud-pm.json`。没有就说明本功能没开云端 PM：照卡片原规矩记 `BLOCKED` 后停止，不要运行脚本。
- 环境变量 `NOTION_TOKEN_V2` 已设（浏览器 Cookie 里的 token_v2；脚本直连 Notion、走账号的个人 agent「云端PM」）。没设脚本会退出码 2，记 `BLOCKED`。若提示 token 过期（401），让用户重新取一次。
- 机器上有 `python`（PATH 中，3.10+）且已装 `requests`、`curl_cffi`（Notion 会拒绝 Node/裸 requests 的 TLS 指纹，返回 `400 UserValidationError`）。自检：`python -c "import requests, curl_cffi"` 无报错即可；缺依赖时脚本退出码 2，记 `BLOCKED`。
- 当前目录在 git 仓库内，且存在 `origin/main`、`main` 或 `master` 基线（`#R-` 头要算 40 位 HEAD 与 7 位基线 SHA）；否则脚本退出码 2。基线也可用 `--base` 指定。
- PM 默认用 `claude-sonnet5.5`。要换模型设环境变量 `NOTION_PM_MODEL`（传 `auto` 让账号 agent 自选）；账号不支持所选模型时脚本会自动摘掉 model 以 Auto 重试。

## 子命令与时机（协议 §1 / §2）

| 时机 | 子命令 | 上行类型 |
|---|---|---|
| 新卡开工前，或口径变化后 | `plan` | `#R-PLAN` |
| 每完成一个里程碑 / 每 2 小时 / 每轮 runner 结束后（不阻塞开发） | `check` | `#R-CHECK` |
| 申请合并（证据包） | `ready`（`merge` 同义） | `#R-READY` |
| 同一问题试 2 次仍不行；需要白名单外改动；卡片与实际不符 | `blocked` | `#R-BLOCKED` |
| 合并后回报 | `done` | `#R-DONE` |
| 事故（main/runner 红、机器异常、误操作） | `alert` | `#R-ALERT` |

```
node "$P/scripts/pm-ask.cjs" plan    --dispatch "…/.dispatch/功能名" --task T03 --msg-file "work/T03/plan.md"
node "$P/scripts/pm-ask.cjs" ready   --dispatch "…" --task T03 --msg-file "work/T03/ready.md"    # merge 同义
node "$P/scripts/pm-ask.cjs" blocked --dispatch "…" --task T03 --msg "卡在哪、试过什么、run 号"
```

- **正文照抄协议第 2 节的模板**（§2.1–§2.6），条目不许增删；`#R-CHECK` 等简单汇报可直接 `--msg`，其余建议写文件用 `--msg-file`（避免 shell 转义改坏证据原文）。
- **`#R-` 头不要自己写**：脚本用本地 git 生成（卡号 / 分支 / 40 位 HEAD / 7 位 main / ISO 时间）。正文若自带 `#R-` 头，脚本会丢弃并用实测值重生成。
- 过渡期别名 `review`：正文第一行必须写 `#R-<类型>`，脚本据此路由；新代码一律用正式子命令。
- **一次说全**：每条 `#R-*` 都要把 PM 读不到的证据（命令原文、汇总行原文、退出码、run 号、完整 SHA）一次给全。缺项时 PM 只回一次 `#D-NEED` 列全，补齐后不再来回。
- 同一张卡第二次呼叫会续用上一次的上下文（`work/<卡号>/pm-session.json` 重放最近 2 轮）；`--new` 强制重开。

## 收到回复后（协议 §3）

回复 = 文本头 + 说明（给人看）+ 末尾 **JSON 决策块**（给脚本读）。**以 JSON 块为准**，文本只做解释。json 已落在 `work/<卡号>/pm-reply-*.json`，字段：`decision` / `directive` / `head_sha` / `actions` / `report` / `tasks`。

| directive | 你做什么 |
|---|---|
| `GO` | 计划通过；按对 Q# 的逐条答复写代码 |
| `FIX` | 只改「阻塞项」列出的位置（白名单内），改完发 `ready`（只列增量）。同卡质量打回累计满 2 次，PM 会直接改 `SPLIT` |
| `MERGE` | PM 默认自己合并，你无需动作，等 `REBASE` 或下一条指令；只有 `actions` 里明确有 `merge_pr` 才由你执行 |
| `REBASE` | 按 `actions.onto` / `conflict_rule` rebase，并重跑指定套件；完成后发 `check` 带结果 |
| `E2E` | 按 `actions.ref` / `suites` / `budget_left` 触发，回 `check` 带 run 号与每套件汇总行原文 |
| `HOLD` | 立即停手：停止触发 E2E 与所有本机操作；回 `check` 写「已停手」 |
| `RESUME` | 解除停手，恢复工作 |
| `SPLIT` | 不要去做拆出的新任务；回复贴进结果文件，状态记 `BLOCKED` 停止 |
| `NEED` | 把列出的一次性缺项全部补齐，再发对应 `#R-*` |
| `ESCALATE` | 触及红线：记 `BLOCKED` 停卡 |

`actions` 是**封闭词表**（协议 §3.1），只执行列出的动作；且 `head_sha` 必须等于当前 `git rev-parse HEAD`，不吻合 → 不执行，回 `#R-BLOCKED`。词表：

- `edit`：只改 `paths` 列出的文件（卡片白名单内）
- `run_gates`：跑 `cmds` 里的离线门禁
- `rebase`：rebase 到 `onto`，按 `conflict_rule` 处理冲突
- `trigger_e2e`：按 `ref` / `suites` 触发，`budget_left` 为剩余预算
- `merge_pr`：HEAD 必须等于 `match_head`，否则回 `#R-ALERT`
- `delete_branch`：只删本轮已合入的功能分支或 `tmp/*`
- `hold` / `resume`
- `claim_next`：领取本线下一张 Ready 且无阻塞的卡，先发 `#R-PLAN`

任何 `actions` 都**不得突破**卡片硬规则（白名单外、密钥、用户真实配置）。`#R-CHECK` 不阻塞：发完按回复继续开发。Tasks 状态只由 PM 改，你不要动。

## 三条硬规矩（协议 §0.4）

1. **一次说全**：信息不全，PM 只回一次 `#D-NEED`。
2. **同一 SHA**：授权只对 json 写明的 HEAD 有效；分支一变授权作废，重新申请。
3. **断言只增不减**：任何删除或放宽断言，必须在 `#R-READY` 第 6 项逐条写明「原实质→新实质→取代者」。

## 红线（协议 §0.3，触及即按 `ESCALATE` 处理）

发版 / 出包 / 对外发布；花钱 / 订阅 / 新增外部服务或账号；改用户机器配置、读写任何密钥；破坏性 git（强推 main、删 main、改分支保护、改仓库可见性）；超出本轮范围的新功能。遇到就记 `BLOCKED` 停卡。

## 不许做

- 不主动做 git 写操作。**唯一例外**：`#D-*` 的 `actions` 词表内、且 `head_sha` 与当前 HEAD 吻合的操作（含 rebase、`merge_pr`）。
- 不越出卡片 §4 白名单；不装/卸依赖；不读写密钥；不改用户配置；不发版、不新增付费服务。
- 凭据只从环境变量读：`NOTION_TOKEN_V2` 不回显、不写进结果文件/日志/卡片或任何文件。
- 不改 `cloud-pm.json`、`pm-session.json`、卡片、台账、Tasks。
- 不向用户提问。脚本失败（退出码 1/2）时，把终端输出（错误原文）贴进结果文件，记 `BLOCKED` 停止。

## 退出码

0 拿到回复 ／ 1 接口失败（贴原文，记 `BLOCKED`）／ 2 用法或配置错误（缺 token、缺 cloud-pm.json、非 git 仓库等）。

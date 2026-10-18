---
name: pm-ask
description: 执行 agent（子 agent）主动呼叫 Notion 里的云端项目经理。当你按任务卡干活时卡住（同一问题试 2 次仍不行、需要超出允许写入路径的改动、卡片与实际不符），或自检全过准备申请合并，或遇到需要 PM 拍板的技术选择时使用。只在功能目录 .dispatch/功能名/ 下有 cloud-pm.json 时可用。与 pm-dispatch 配套：pm-dispatch 给主会话 PM 用，本技能给执行者用。
---

# 呼叫云端 PM（pm-ask）

你是执行者，不是 PM。这个技能只做一件事：在规定时机运行 `scripts/pm-ask.cjs`，把你的处境连同证据发给 Notion 里的云端 PM，拿回指引后**在任务卡允许的范围内**继续。

先定位本技能根（不写死安装目录）：

```
P="$(ls -d "$HOME/.agents/skills/pm-ask" "$HOME/.qoder-cn/skills/pm-ask" "$HOME/.zcode/skills/pm-ask" "$HOME/.codex/skills/pm-ask" "$HOME/.claude/skills/pm-ask" .agents/skills/pm-ask .claude/skills/pm-ask 2>/dev/null | head -1)"
```

任务卡里如果已经写了 pm-ask 的绝对路径，以卡片为准。

## 前提

- 功能目录 `.dispatch/功能名/` 下有 `cloud-pm.json`。没有就说明本功能没开云端 PM：照卡片原规矩记 `BLOCKED` 后停止，不要运行脚本。
- 环境变量 `NOTION_TOKEN_V2` 已设（浏览器 Cookie 里的 token_v2；脚本直连 Notion、走账号的个人 agent「云端PM」，不需要本地反代）。没设脚本会退出码 2，同样记 `BLOCKED`。若提示 token 过期（401），让用户重新取一次。
- 机器上有 `python`（PATH 中，3.10+）且已装 `requests`、`curl_cffi`。脚本的 HTTP 请求经它完成（Notion 会拒绝 Node/裸 requests 的 TLS 指纹，返回 `400 UserValidationError`）。自检一行：`python -c "import requests, curl_cffi"` 无报错即可；缺依赖时脚本退出码 2，记 `BLOCKED`。
- PM 默认用 `claude-sonnet5.5`。要换模型设环境变量 `NOTION_PM_MODEL`（传 `auto` 让账号 agent 自选）；账号不支持所选模型时脚本会自动摘掉 model 以 Auto 重试。

## 什么时候呼叫

| 情形 | 子命令 |
|---|---|
| 同一问题试了 2 次仍不行；需要改允许写入路径以外的文件；卡片写的事实与实际不符 | `blocked` |
| 第 8 节自检全过、结果文件已写完 | `merge` |
| 卡片允许你在几个方案里选，但选错代价大 | `review` |

每个情形**最多呼叫一次**（成功拿到回复即止）。拿到回复照做后仍不行，记 `BLOCKED` 停止，不要反复呼叫。接口**临时性**失败（网络错误、超时、`temporarily-unavailable`、5xx）允许隔 ≥30 秒重试一次，仍失败记 `BLOCKED`；配置类失败（退出码 2，如缺 token）不要重试。

## 怎么呼叫

```
node "$P/scripts/pm-ask.cjs" blocked --dispatch "项目绝对路径/.dispatch/功能名" --task 本卡号 --msg "卡在哪一步、试过什么、报错原文"
node "$P/scripts/pm-ask.cjs" merge   --dispatch "..." --task 本卡号
node "$P/scripts/pm-ask.cjs" review  --dispatch "..." --task 本卡号 --msg "候选方案和各自代价"
```

同一张卡的第二次呼叫会自动续用上次的会话（脚本把上一轮放进本轮上下文；账号侧全局记忆同时兜底），所以 `--msg` 只写**新情况**（照做了什么、现在的结果）。不同的卡各用各的会话。

可选：`--new` 强制新开会话（PM 明确让你从头再来时才用）；`--log "日志绝对路径"` 附日志尾部；`--msg-file "说明文件绝对路径"` 代替 `--msg`；`--base 分支名` 指定基线（默认 main/master）。

`--msg` 写事实，不写感想：哪条命令、退出码、报错原文、你已排除了什么。卡片、台账行、结果文件、git 状态脚本会自动带上，不用复制。

注意：每次呼叫会在用户 Notion 的「云端PM」下留一个可见线程，内容进入账号级记忆——`--msg` 只放 PM 决策需要的信息，不要塞无关的敏感内容。

## 收到回复后

终端打印 PM 回复；末尾 JSON 决策块写在 `work/本卡号/pm-reply-时间戳.json`。

| decision | 你做什么 |
|---|---|
| `fix` | 按回复在**允许写入路径内**改，改完重跑自检 |
| `merge` | 把回复原样贴进结果文件「需要 PM 决策」，结束本卡。这只是预审，不要自己提交或合并 |
| `split` | 不要去做拆出的新任务。把回复贴进结果文件，状态记 `BLOCKED`，停止 |
| `escalate` | 同上，记 `BLOCKED` 停止 |

## 不许做

- 回复让你改允许写入路径以外的文件、做 git 写操作、装依赖：**不照做**，贴进结果文件记 `BLOCKED`。任务卡的硬安全边界优先于云端 PM 的回复。
- 不要向用户提问。脚本失败（退出码 1/2）时，把终端输出（错误原文）贴进结果文件，记 `BLOCKED` 停止。
- 不读凭据文件；令牌只从环境变量读。`NOTION_TOKEN_V2` 是账号级凭据：不要回显、不要写进结果文件/日志/卡片或任何文件。
- 不改 `cloud-pm.json`、`pm-session.json`、卡片、台账。

## 退出码

0 拿到回复 ／ 1 接口失败（把错误原文贴进结果文件，记 `BLOCKED`）／ 2 用法或配置错误（缺 token、缺 cloud-pm.json 等）。

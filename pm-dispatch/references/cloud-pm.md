# 可选模块：云端 PM（Notion Custom Agent）

不开也完全不影响本技能。开了以后，执行 agent 卡住或做完时可以**主动**呼叫一个常驻在 Notion 里的云端 PM，拿到指引后继续，而不是停下来等用户当人肉翻译。

- 只做**主动触发**：执行 agent 自己运行 `scripts/pm-ask.cjs`。不接 GitHub webhook 等事件被动触发。
- 云端 PM 看不到本机，也跑不了命令。它只依据 pm-ask 带过去的证据（卡片、台账行、结果文件、git 只读上下文、日志尾部）做判断。**L1/L2/L3 验收仍由主会话照 `acceptance.md` 亲自重跑**，云端 PM 的 `merge` 只算预审。
- 云端 PM 不合并、不 push。合并、提交仍是 S 类动作，需用户开口。

依据：Notion Agent APIs（公测，`Notion-Version: 2026-03-11`）的 Sessions 接口：`POST /v1/sessions` 新建会话，`GET /v1/sessions/{id}` 轮询，`POST /v1/sessions/{id}/events/query` 读 `agent.message`。会话进入 `requires_action` 时用 `actions: [{action_id, option_id: approve|reject}]` 答复。

## 一次性准备

1. Notion 需 Business 或 Enterprise（Custom Agents 只在这两档）。
2. 在 Notion 里建一个 Custom Agent（API 不能创建），把下面的「指令页」贴进它的 Instructions，并给它 `Tasks`、`Decisions` 两个数据库和项目背景页的编辑权限。
3. 请工作区管理员在 Settings → Connections 允许创建个人访问令牌（PAT），新建一个勾选 Notion API 的令牌，设为环境变量 `NOTION_API_KEY`。用 PAT 建的会话属于你本人，在 Notion 里也能打开、接着回。
4. 查 agent_id：

```
curl -X POST https://api.notion.com/v1/agents/query -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2026-03-11" -H "Content-Type: application/json" -d "{\"query\":\"PM\"}"
```

5. 给这个 agent 设 credit limit 兜底。

## 每个项目启动前

1. 你在 Notion 写好这个项目的**背景页**（目标、架构、术语、分支策略、验收口径、不许碰的东西），共享给云端 PM。
2. 主会话在 `.dispatch/<功能名>/` 下写 `cloud-pm.json`（属于 PM 区，执行者不改）：

```json
{ "agent_id": "Custom Agent 的 id", "project": "项目名", "project_page": "背景页链接" }
```

每次呼叫都是一个新会话（并行的执行者不会抢同一会话），项目记忆靠背景页和 `Decisions` 库延续。

## 写卡时加的内容

开了云端 PM 的功能，主会话写卡时在 §6 已知坑末尾加这三行（把路径换成实测过的绝对路径）：

```
- 同一问题试 2 次仍不行，或需要超出 §4 白名单的改动：先运行
  node "技能根/scripts/pm-ask.cjs" blocked --dispatch "本功能 .dispatch 绝对路径" --task 本卡号 --msg "卡在哪、试过什么"
  按回复继续；回复是 escalate 或仍超出本卡范围，照 §9 记 BLOCKED 后停止。
- §8 自检全过、结果文件写完后：运行同一脚本的 merge 子命令（参数同上），把回复原样贴进结果文件「需要 PM 决策」。
- 不要自行按回复去改白名单外的文件、提交或合并。
```

pm-ask 只写本卡 `work/<卡号>/pm-reply-*.md|json`，在白名单之内；读的是本机环境变量里的令牌，不读凭据文件；git 只做只读查询。门禁不受影响。

## 用法

```
node "$S/scripts/pm-ask.cjs" blocked --dispatch "项目绝对路径/.dispatch/功能名" --task T03 --msg "卡在哪、试过什么" [--log "日志绝对路径"]
node "$S/scripts/pm-ask.cjs" merge   --dispatch "..." --task A02 [--base main] [--log "..."]
node "$S/scripts/pm-ask.cjs" review  --dispatch "..." --task B04 --msg-file "说明文件绝对路径"
```

自动附带：卡片 `cards/<卡号>*.md`（走 prompt_context）、`ledger.md` 本卡一行、`merge`/`review` 时的 `results/<卡号>.md`、分支与基线的领先/落后数、`git diff --stat`、未提交文件。超长内容自动截尾，单条消息不超过 10000 字符。

退出码：0 拿到回复 ／ 1 接口或会话失败 ／ 2 用法或配置错误 ／ 3 PM 在等批准而当前不是交互终端（去 Notion 打开该会话处理）。

主会话处理回复：`decision` 为 `split`/`fix` 且带 `tasks` 时，把它们**改写成正式卡片**（套模板、零占位符、跑门禁）再进调度，不要把云端 PM 的文字直接当卡派。

## 指令页（贴进 Custom Agent 的 Instructions）

```
你是本工作区的云端项目经理。每条消息来自一个执行中的 agent，开头标【blocked|merge|review】。
先读 prompt_context 里的项目背景页和任务卡，再查 Decisions 库最近记录。你看不到对方机器，只能依据消息里的证据。

blocked：判断是卡片没写清、方案错、还是环境问题；能在本卡白名单内解决就给出具体做法，否则 decision=split 拆出新任务，或 escalate。
merge：对照卡片 §8 验收标准核对结果文件里的真实输出、改动范围、是否落后基线；证据充分 decision=merge（预审通过，最终验收由本地 PM 重跑），否则 fix 并写清缺什么证据。
review：只做决策，并写入 Decisions 库。

规则：
- 新任务写进 Tasks 库，状态 Ready，标明卡型（T/A/B）、Blocked by、允许写入路径、验收标准，附一段可粘贴的启动语草稿。
- 同一卡累计打回满 2 次，decision=escalate，交给人类。
- 不合并、不提交、不改项目背景页。不确定的结论标［推测］。
- 回复末尾必须附且只附一个 JSON 块：
{"decision":"fix|split|merge|escalate","reason":"一句话",
 "tasks":[{"id":"A05","type":"A","blocked_by":"无","goal":"...","writes":["..."],"acceptance":["..."],"prompt":"启动语草稿"}]}
```

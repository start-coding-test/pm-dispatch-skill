"""pm-ask 内层助手：由 pm-ask.cjs 通过子进程调用，用一个 agent_service 回合把 prompt 发给云端 PM。

- stdin : 完整 prompt（UTF-8，含证据与本卡历史）
- env   : NOTION_TOKEN_V2（必需）
          NOTION_PM_MODEL（可选，默认 auto —— 让账号 agent 自选模型）
          NOTION_URL / NOTION_PROXY / NOTION_CLIENT_VERSION（可选，透传给 notion_direct）
- stdout: 纯文本回复（UTF-8）
- stderr: 诊断信息（含 thread_id=<uuid> 一行，供 cjs 记账）
- 退出码: 0 成功 / 1 上游或网络失败 / 2 配置错误（缺 token、token 失效）

依赖本目录同级的 notion_direct.py（打包副本；上游模块更新时需要同步）。
"""

import os
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from notion_direct import NotionDirect, NotionUpstreamError, resolve_account  # noqa: E402


def main() -> int:
    token = (os.environ.get("NOTION_TOKEN_V2") or "").strip()
    if not token:
        print("[pm-ask-turn] 缺少环境变量 NOTION_TOKEN_V2", file=sys.stderr)
        return 2

    prompt = sys.stdin.read()
    if not prompt.strip():
        print("[pm-ask-turn] 收到的 prompt 为空", file=sys.stderr)
        return 2

    try:
        acct = resolve_account(token)
    except Exception as exc:
        print(f"[pm-ask-turn] 账号解析失败（token 可能无效或已过期）: {exc}", file=sys.stderr)
        return 2

    client = NotionDirect(
        token_v2=token,
        space_id=acct["space_id"],
        user_id=acct["user_id"],
        runtime="agent_service",
    )
    model = (os.environ.get("NOTION_PM_MODEL") or "auto").strip() or "auto"
    try:
        result = client.chat(prompt, model=model)
    except NotionUpstreamError as exc:
        print(
            f"[pm-ask-turn] 上游错误: {exc} (status={exc.status_code}, excerpt={exc.response_excerpt})",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(f"[pm-ask-turn] 调用失败: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"[pm-ask-turn] thread_id={result.thread_id}", file=sys.stderr)
    sys.stdout.write(result.text or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

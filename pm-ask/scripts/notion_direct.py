"""Notion AI 直连客户端 —— notion2api-next 抽离版（无 FastAPI 反代 / 账号池 / SQLite）。

来源: https://github.com/1809543182/notion2api-next （上游 maverickxone/notion2api 的维护 fork）
  - app/notion_client.py  -> NotionDirect（两种运行时：agent_service / legacy）
  - app/stream_parser.py  -> parse_stream（legacy NDJSON 流解析，原样保留）
  - app/conversation.py   -> build_transcript / 系统提示词改写
  - app/model_sync.py     -> fetch_available_models（线上模型目录漂移检查）
  - login.py              -> resolve_account（只凭 token_v2 解析 space_id / user_id）

依赖:  pip install curl_cffi requests
       curl_cffi 强烈建议装：2026-10 起 Notion 用 JA3 指纹拒绝 python-requests /
       cloudscraper（回包 temporarily-unavailable / UserValidationError / 空流）。
       curl_cffi 走 Chrome 指纹；没有它退回 cloudscraper，再没有则 requests.Session。

运行时（NOTION_RUNTIME 环境变量或构造函数 runtime 参数）:
  - "agent_service"（默认，2026-10 起 Notion 网页端协议）：createAgentThread +
    listenToThreadTranscript；多轮历史摊平成单条 prompt（<conversation_history>）。
  - "legacy"：旧的 runInferenceTranscript（2026-10-17 仍可用，可能被 Notion 下线）。

凭据:  必需 token_v2（浏览器 DevTools -> Cookie 里的 token_v2）；
       space_id / user_id 可自动解析：
         NOTION_TOKEN_V2=xxx python notion_direct.py check
       线上模型目录漂移检查：
         NOTION_TOKEN_V2=xxx python notion_direct.py models

用法:
    client = NotionDirect(token_v2, space_id, user_id)
    print(client.chat("你好").text)              # 一次性拿最终文本
    for ev in client.stream("讲个笑话"):          # 流式事件
        print(ev)

注意:
  - 非官方接口，Notion 更新后可能需同步 NOTION_CLIENT_VERSION（环境变量可覆盖）。
  - legacy 运行时 thread 的模型是"粘"的：同一 thread_id 换模型不生效；agent_service
    每次请求新建 thread，传入的 thread_id 会被忽略（上下文靠 history 摊平）。
  - 代理：NOTION_PROXY / HTTPS_PROXY 环境变量，或构造函数 proxies dict。
"""

from __future__ import annotations

import datetime
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Generator, Iterable, Optional

import requests
import urllib3

try:
    import cloudscraper
except ImportError:  # 可选依赖
    cloudscraper = None

try:  # Chrome TLS/HTTP2 指纹；2026-10 起 Notion 用 JA3 拒绝 python-requests
    from curl_cffi import requests as cffi_requests
except Exception:
    cffi_requests = None

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

NOTION_CLIENT_VERSION = os.getenv("NOTION_CLIENT_VERSION", "23.13.20261017.0323")
# 2026-10: Notion 网页端与 AI 接口迁到 app.notion.com（旧 www.notion.so 已退役）
NOTION_URL = os.getenv("NOTION_URL", "https://app.notion.com").rstrip("/")
NOTION_IMPERSONATE = os.getenv("NOTION_IMPERSONATE", "chrome").strip()
NOTION_RUNTIME = os.getenv("NOTION_RUNTIME", "agent_service").strip().lower()
AGENT_SERVICE_TIMEOUT_S = float(os.getenv("AGENT_SERVICE_TIMEOUT_S", "240"))
AGENT_SERVICE_DELETE_THREAD = os.getenv("AGENT_SERVICE_DELETE_THREAD", "false").strip().lower() in ("1", "true", "yes")
NOTION_DEBUG_OVERRIDES = os.getenv("NOTION_DEBUG_OVERRIDES", "false").strip().lower() in ("1", "true", "yes")

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
_SEC_CH_UA = '"Chromium";v="141", "Not?A_Brand";v="8", "Google Chrome";v="141"'


def _proxy_config() -> Optional[dict[str, str]]:
    proxy = (
        os.getenv("NOTION_PROXY")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("ALL_PROXY")
        or os.getenv("all_proxy")
        or ""
    ).strip()
    return {"http": proxy, "https": proxy} if proxy else None


def _new_http_session(impersonate: str = "chrome", proxies: Optional[dict[str, str]] = None):
    """浏览器指纹会话：curl_cffi 优先，cloudscraper 次之，最后裸 requests。"""
    proxies = proxies if proxies is not None else _proxy_config()
    if cffi_requests is not None and (impersonate or "").lower() not in ("", "0", "off", "none", "false"):
        try:
            return cffi_requests.Session(impersonate=impersonate, proxies=proxies)
        except TypeError:  # 老版 curl_cffi 不支持 proxies 参数
            session = cffi_requests.Session(impersonate=impersonate)
            if proxies:
                session.proxies = proxies
            return session
    if cloudscraper is not None:
        session = cloudscraper.create_scraper()
    else:
        session = requests.Session()
    if proxies:
        try:
            session.proxies.update(proxies)
        except Exception:
            pass
    return session


_TRANSPORT_ERRORS: tuple = (requests.exceptions.RequestException,)
_TIMEOUT_ERRORS: tuple = (requests.exceptions.Timeout,)
if cffi_requests is not None:
    from curl_cffi.requests import exceptions as _cffi_exc

    _TRANSPORT_ERRORS = _TRANSPORT_ERRORS + (_cffi_exc.RequestException,)
    _TIMEOUT_ERRORS = _TIMEOUT_ERRORS + (_cffi_exc.Timeout,)

# ---------------------------------------------------------------------------
# 模型代号表（Notion 内部 codename；Notion 调整后需要更新这里）
# ---------------------------------------------------------------------------

MODEL_MAP: dict[str, str] = {
    # Anthropic
    "claude-sonnet5.5": "achira-donut",
    "claude-opus5.5": "albuquerque-quinn",
    "claude-haiku5.5": "amla-jam",
    "claude-opus5": "agave-flan",
    "claude-sonnet5": "angel-cake-high",
    "claude-sonnet4.6": "almond-croissant-low",
    "claude-opus4.8": "ambrosia-tart-high",
    "claude-opus4.7": "apricot-sorbet-high",
    "claude-opus4.6": "avocado-froyo-medium",
    "claude-haiku4.5": "anthropic-haiku-4.5",
    # OpenAI
    "gpt-6.1-sol": "omniberry-sundae",
    "gpt-6-luna": "omodi",
    "gpt-6-astra": "orlando-quinn",
    "gpt-5.6-sol": "orange-mousse",
    "gpt-5.6-terra": "orchid-muffin",
    "gpt-5.6-luna": "olive-jellyroll",
    "gpt-5.5": "opal-quince-medium",
    "gpt-5.4": "oval-kumquat-medium",
    "gpt-5.4-mini": "oregon-grape-medium",
    "gpt-5.4-nano": "otaheite-apple-medium",
    "gpt-5.2": "oatmeal-cookie",
    # Google
    "gemini-3.7flash": "grapefruit-zeppole",
    "gemini-3.6flash": "vertex-gemini-3.6-flash",
    "gemini-3.5flash": "vertex-gemini-3.5-flash",
    "gemini-3.1pro": "galette-medium-thinking",
    "gemini-3flash": "gingerbread",
    # Moonshot / xAI / DeepSeek / Zhipu
    "kimi-k3": "fireworks-kimi-k3",
    "grok-4.6": "soursop-shortcake",
    "grok-4.3": "xigua-mochi-medium",
    "spacexai-4.5": "strawberry-whoopiepie",
    "grok-build0.1": "xinomavro-cake",
    "deepseek-v4flash": "baseten-deepseek-v4-flash",
    "deepseek-v4.1flash": "baseten-deepseek-v4.1-flash",
    "deepseek-v4pro": "baseten-deepseek-v4-pro",
    "glm-5.3": "baseten-glm-5.3",
    "glm-5.3flash": "baseten-glm-5.3-flash",
    "glm-5.2": "baseten-glm-5.2",
    # Notion 自家 / Auto
    "auto": "auto",
    "fable-5.1": "assam-chai",
    "fable-5": "acai-budino-high",
}
NOTION_MODEL_REVERSE_MAP: dict[str, str] = {v: k for k, v in MODEL_MAP.items() if v != k}
_DEFAULT_REQUESTED = os.getenv("DEFAULT_MODEL", "").strip()
DEFAULT_MODEL = _DEFAULT_REQUESTED if _DEFAULT_REQUESTED in MODEL_MAP else "claude-sonnet5.5"

# 只有 vertex- 前缀的模型走 legacy 的 markdown-chat（需要 saveTransactions 预建 thread）
MARKDOWN_CHAT_MODELS: set[str] = {
    "vertex-gemini-3.5-flash",
    "vertex-gemini-3.6-flash",
}


def get_notion_model(model_name: str) -> str:
    """模型名 -> Notion 内部 codename。支持标准 id / 原始 codename / auto，大小写容错。"""
    name = (model_name or "").strip()
    if name in MODEL_MAP:
        return MODEL_MAP[name]
    if name in NOTION_MODEL_REVERSE_MAP:
        return name
    lowered = name.lower()
    if lowered in MODEL_MAP:
        return MODEL_MAP[lowered]
    if lowered in NOTION_MODEL_REVERSE_MAP:
        return lowered
    return MODEL_MAP[DEFAULT_MODEL]


def get_thread_type(model_name: str) -> str:
    return "markdown-chat" if get_notion_model(model_name) in MARKDOWN_CHAT_MODELS else "workflow"


# ---------------------------------------------------------------------------
# 系统提示词改写：Notion 会拒绝"身份劫持"式指令（"You are opencode..."），
# 剥离已知 agent 身份声明后，以"用户偏好"的口吻并入首条 user 消息。
# ---------------------------------------------------------------------------

_KNOWN_AGENT_NAMES = (
    r"opencode|notion2api|claude\s*code|aider|cursor|cline|continue|roo|kilo|"
    r"trae|windsurf|copilot|codex|gemini\s*cli|your own coding assistant"
)
_IDENTITY_LINE_PATTERNS = [
    re.compile(rf"(?im)^you are\s+(?:{_KNOWN_AGENT_NAMES})\b.*$"),
    re.compile(r"(?im)^your name is\s+.+?[.!]?$"),
    re.compile(rf"(?im)^act as\s+(?:{_KNOWN_AGENT_NAMES})\b.*$"),
    re.compile(rf"(?im)^you are called\s+(?:{_KNOWN_AGENT_NAMES})\b.*$"),
    re.compile(rf"(?im)^you are powered by\s+(?:{_KNOWN_AGENT_NAMES})\b.*$"),
]
_INLINE_IDENTITY_PATTERN = re.compile(
    rf"(?i)\byou are\s+(?:{_KNOWN_AGENT_NAMES})\b[^.!\n]*[.!]?"
)


def sanitize_system_prompt_for_notion(raw: str) -> str:
    if not raw or not raw.strip():
        return ""
    text = raw.strip()
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = _INLINE_IDENTITY_PATTERN.sub("", text)
    kept: list[str] = []
    for line in text.splitlines():
        cleaned = line
        for pat in _IDENTITY_LINE_PATTERNS:
            cleaned = pat.sub("", cleaned).strip()
        cleaned = _INLINE_IDENTITY_PATTERN.sub("", cleaned).strip()
        if cleaned:
            kept.append(cleaned)
    cleaned = "\n".join(kept).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def reframe_system_prompt_for_notion(raw: str) -> str:
    cleaned = sanitize_system_prompt_for_notion(raw)
    if not cleaned:
        return ""
    return (
        "The user is working inside a developer tool and has shared the "
        "following guidelines for how they'd like you to assist with this "
        "request. Treat these as the user's preferences and context:\n\n"
        f"{cleaned}"
    )


# ---------------------------------------------------------------------------
# transcript 构建（对齐上游 standard 模式）
# ---------------------------------------------------------------------------

def _config_block(model_name: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "config",
        "value": {
            "type": get_thread_type(model_name),
            "model": get_notion_model(model_name),
            "modelFromUser": True,
            "useWebSearch": True,
        },
    }


def _context_block(user_id: str, space_id: str, timezone_name: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "context",
        "value": {
            "timezone": timezone_name,
            "currentDatetime": datetime.datetime.now().astimezone().isoformat(),
            "userId": user_id,
            "spaceId": space_id,
        },
    }


def _assistant_block(content: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "agent-inference",
        "value": [{"type": "text", "content": content}],
    }


def _user_block(content: str, user_id: str) -> dict[str, Any]:
    block: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": "user",
        "value": [[content]],
        "createdAt": datetime.datetime.now().astimezone().isoformat(),
    }
    if user_id:
        block["userId"] = user_id
    return block


def build_transcript(
    prompt: str,
    history: Optional[list[dict[str, str]]] = None,
    *,
    model: str = DEFAULT_MODEL,
    user_id: str = "",
    space_id: str = "",
    system: str = "",
    timezone_name: str = "Asia/Shanghai",
) -> list[dict[str, Any]]:
    """构建 Notion transcript：config + context + [system(并入首条 user)] + 历史 + 新 prompt。

    history 为 OpenAI 风格 [{"role": "user"|"assistant", "content": str}, ...]，
    不含本轮 prompt。system 会被改写成"用户偏好"并入第一条 user 消息。
    """
    transcript: list[dict[str, Any]] = [
        _config_block(model),
        _context_block(user_id, space_id, timezone_name),
    ]

    messages: list[tuple[str, str]] = []
    for msg in history or []:
        role = str(msg.get("role", "")).lower()
        content = str(msg.get("content", "") or "")
        if role in ("user", "assistant") and content:
            messages.append((role, content))
    messages.append(("user", prompt))

    reframed = reframe_system_prompt_for_notion(system) if system else ""
    merged_first = False
    for role, content in messages:
        if role == "user" and not merged_first:
            merged_first = True
            if reframed:
                content = f"{reframed}\n\n{content}"
        transcript.append(_assistant_block(content) if role == "assistant" else _user_block(content, user_id))
    return transcript


# ---------------------------------------------------------------------------
# NDJSON 流解析（原样搬运 app/stream_parser.py，去掉日志）
# ---------------------------------------------------------------------------

_RE_LANG_FULL = re.compile(r"<lang\b[^>]*>(.*?)</lang>", re.DOTALL)
_RE_LANG_OPEN = re.compile(r"<lang\b[^>]*>")
_RE_LANG_CLOSE = re.compile(r"</lang>")
_RE_PRIMARY_ATTR = re.compile(r'\bprimary="[a-zA-Z\-]{1,15}"\s*')
_RE_ATTR_TAIL = re.compile(r'^-?[a-zA-Z]{0,4}"\s*>\s*')
_RE_PRIMARY_START = re.compile(r"\bprimary\b", re.IGNORECASE)

SEARCH_PATH_KEYWORDS = ("search", "web", "query", "source", "citation", "tool")
SEARCH_TYPE_KEYWORDS = ("search", "web", "tool", "citation")
SEARCH_VALUE_KEYS = (
    "queries", "query", "questions", "category", "sources", "citations",
    "results", "url", "urls", "href", "search", "web", "tool", "toolname",
    "tooltype", "internal",
)

_THINKING_TYPES = ("agent-inference", "thinking", "reasoning", "inference")
_TOOL_TYPES = ("agent-tool-result", "tool_use", "tool", "search", "web", "citation")

SEG_THINKING = "thinking"
SEG_TOOL = "tool"
SEG_CONTENT = "content"
SEG_META = "meta"

FINAL_STEP_PRIORITIES: dict[str, int] = {
    "markdown-chat": 400,
    "text": 350,
    "agent-inference": 300,
    "title": 50,
}


def _strip_lang_tags(text: str, in_tag: list[bool]) -> str:
    result = []
    i = 0
    while i < len(text):
        if in_tag[0]:
            end = text.find(">", i)
            if end == -1:
                break
            in_tag[0] = False
            i = end + 1
            continue

        lang_start = text.find("<lang", i)
        close_start = text.find("</lang>", i)
        candidates = [(pos, typ) for pos, typ in [(lang_start, "open"), (close_start, "close")] if pos != -1]
        if not candidates:
            result.append(text[i:])
            break

        next_pos, typ = min(candidates, key=lambda x: x[0])
        result.append(text[i:next_pos])

        if typ == "close":
            i = next_pos + len("</lang>")
            continue

        end = text.find(">", next_pos)
        if end == -1:
            in_tag[0] = True
            break
        i = end + 1

    return "".join(result)


def _clean_notion_markup(text: str) -> str:
    text = _RE_LANG_FULL.sub(r"\1", text)
    text = _RE_LANG_CLOSE.sub("", text)
    text = _RE_LANG_OPEN.sub("", text)
    text = _RE_PRIMARY_ATTR.sub("", text)
    text = _RE_ATTR_TAIL.sub("", text)
    return text


def _strip_primary_attr_fragments(text: str, in_primary_attr: list[bool]) -> str:
    out: list[str] = []
    i = 0
    while i < len(text):
        if in_primary_attr[0]:
            ch = text[i]
            if ch in ">\r\n":
                in_primary_attr[0] = False
                i += 1
                continue
            if ch.isalpha() or ch in '-_="\'/: ':
                i += 1
                continue
            in_primary_attr[0] = False
            continue

        m = _RE_PRIMARY_START.search(text, i)
        if not m:
            out.append(text[i:])
            break

        start = m.start()
        out.append(text[i:start])

        j = m.end()
        while j < len(text) and text[j].isspace():
            j += 1

        if j < len(text) and text[j] not in ("=", "\"", "'"):
            out.append(text[start:m.end()])
            i = m.end()
            continue

        if j < len(text) and text[j] == "=":
            j += 1
            while j < len(text) and text[j].isspace():
                j += 1

        if j < len(text) and text[j] in ("\"", "'"):
            quote = text[j]
            j += 1
            while j < len(text) and (text[j].isalpha() or text[j] in "-_"):
                j += 1
            if j < len(text) and text[j] == quote:
                j += 1
        else:
            while j < len(text) and (text[j].isalpha() or text[j] in "-_"):
                j += 1

        while j < len(text) and text[j] in " />":
            j += 1

        if j >= len(text):
            in_primary_attr[0] = True
            break

        i = j

    return "".join(out)


def _normalize_path(patch: dict[str, Any]) -> str:
    for key in ("path", "p", "pointer", "at"):
        if key not in patch:
            continue
        raw = patch.get(key)
        if isinstance(raw, (list, tuple)):
            return "/".join(str(part) for part in raw)
        return str(raw)
    return ""


def _extract_segment_index(path: str) -> int | None:
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2 or parts[0] != "s":
        return None
    try:
        return int(parts[1])
    except Exception:
        return None


def _extract_value_index(path: str) -> int | None:
    parts = [p for p in path.split("/") if p]
    for i, part in enumerate(parts):
        if part == "value" and i + 1 < len(parts):
            try:
                return int(parts[i + 1])
            except ValueError:
                return None
    return None


def _extract_value_add_index(path: str) -> int | None:
    parts = [p for p in path.split("/") if p]
    if len(parts) != 4:
        return None
    if parts[0] != "s" or parts[2] != "value":
        return None
    idx_raw = parts[3]
    if idx_raw == "-":
        return -1
    try:
        return int(idx_raw)
    except ValueError:
        return None


def _contains_search_keys(value: Any) -> bool:
    if isinstance(value, dict):
        for key, val in value.items():
            key_lower = str(key).lower()
            if any(token in key_lower for token in SEARCH_VALUE_KEYS):
                return True
            if _contains_search_keys(val):
                return True
        return False
    if isinstance(value, list):
        return any(_contains_search_keys(item) for item in value)
    return False


def _append_query(out: dict[str, Any], query: str) -> None:
    q = query.strip()
    if q:
        out.setdefault("queries", []).append(q)


def _append_source(out: dict[str, Any], source: dict[str, Any]) -> None:
    title = str(source.get("title", "") or "").strip()
    url = str(source.get("url", "") or "").strip()
    snippet = str(source.get("snippet", "") or "").strip()
    if not title and not url:
        return
    entry: dict[str, str] = {}
    if title:
        entry["title"] = title
    if url:
        entry["url"] = url
    if snippet:
        entry["snippet"] = snippet
    out.setdefault("sources", []).append(entry)


def _collect_search_metadata(value: Any, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        lowered = {str(k).lower(): v for k, v in value.items()}

        if isinstance(lowered.get("queries"), list):
            for item in lowered["queries"]:
                if isinstance(item, str):
                    _append_query(out, item)

        if isinstance(lowered.get("questions"), list):
            for item in lowered["questions"]:
                if isinstance(item, str):
                    _append_query(out, item)

        for single_query_key in ("query", "search_query", "searchquery"):
            query_val = lowered.get(single_query_key)
            if isinstance(query_val, str):
                _append_query(out, query_val)

        category = lowered.get("category")
        if isinstance(category, str) and category.strip():
            out.setdefault("categories", []).append(category.strip())

        for source_key in ("sources", "citations", "results"):
            source_items = lowered.get(source_key)
            if not isinstance(source_items, list):
                continue
            for item in source_items:
                if isinstance(item, dict):
                    _append_source(out, {
                        "title": item.get("title") or item.get("name") or item.get("sourceTitle") or "",
                        "url": item.get("url") or item.get("href") or item.get("link") or item.get("sourceUrl") or "",
                        "snippet": item.get("snippet") or item.get("summary") or item.get("description") or "",
                    })
                elif isinstance(item, str):
                    _append_source(out, {"title": item, "url": item})

        if isinstance(lowered.get("urls"), list):
            for url_item in lowered["urls"]:
                if isinstance(url_item, str) and url_item.strip():
                    _append_source(out, {"title": url_item.strip(), "url": url_item.strip()})

        url_val = lowered.get("url") or lowered.get("href") or lowered.get("link")
        if isinstance(url_val, str):
            _append_source(out, {
                "title": lowered.get("title") or lowered.get("name") or url_val,
                "url": url_val,
                "snippet": lowered.get("snippet") or lowered.get("summary") or "",
            })

        for nested in value.values():
            _collect_search_metadata(nested, out)
        return

    if isinstance(value, list):
        for item in value:
            _collect_search_metadata(item, out)


def _dedupe_search_data(data: dict[str, Any]) -> dict[str, Any]:
    queries = data.get("queries", [])
    sources = data.get("sources", [])
    categories = data.get("categories", [])

    deduped_queries: list[str] = []
    for query in queries:
        if query not in deduped_queries:
            deduped_queries.append(query)

    deduped_sources: list[dict[str, str]] = []
    seen_sources: set[tuple[str, str]] = set()
    for source in sources:
        key = (str(source.get("title", "") or ""), str(source.get("url", "") or ""))
        if key in seen_sources:
            continue
        seen_sources.add(key)
        deduped_sources.append(source)

    deduped_categories: list[str] = []
    for category in categories:
        if category not in deduped_categories:
            deduped_categories.append(category)

    out: dict[str, Any] = {}
    if deduped_queries:
        out["queries"] = deduped_queries
    if deduped_sources:
        out["sources"] = deduped_sources
    if deduped_categories:
        out["categories"] = deduped_categories
    return out


def _looks_like_search_patch(patch: dict[str, Any]) -> bool:
    patch_type = str(patch.get("type", "") or "").lower()
    patch_v = patch.get("v")
    nested_type = ""
    if isinstance(patch_v, dict):
        nested_type = str(patch_v.get("type", "") or "").lower()

    effective_type = patch_type or nested_type
    if effective_type and effective_type != "text" and any(token in effective_type for token in SEARCH_TYPE_KEYWORDS):
        return True

    path = _normalize_path(patch).lower()
    if any(token in path for token in SEARCH_PATH_KEYWORDS):
        return True

    if _contains_search_keys(patch.get("v")):
        return True

    return False


def _extract_search_data_from_patch(patch: dict[str, Any]) -> dict[str, Any]:
    extracted: dict[str, Any] = {"queries": [], "sources": [], "categories": []}
    _collect_search_metadata(patch, extracted)
    return _dedupe_search_data(extracted)


def _extract_text_from_patch(patch: dict[str, Any]) -> str:
    content = ""
    patch_op = patch.get("o")

    if patch_op == "a":
        patch_v = patch.get("v", {})
        if isinstance(patch_v, dict) and "value" in patch_v:
            val = patch_v["value"]
            if isinstance(val, list):
                text_parts = []
                for item in val:
                    if isinstance(item, dict) and isinstance(item.get("content"), str):
                        text_parts.append(str(item.get("content", "")))
                content = "".join(text_parts)
        elif isinstance(patch_v, dict) and "content" in patch_v:
            raw = patch_v.get("content")
            if isinstance(raw, str):
                content = raw

    elif patch_op == "x" and "v" in patch:
        content = patch["v"] if isinstance(patch["v"], str) else ""

    elif patch_op == "p" and "v" in patch:
        path = _normalize_path(patch)
        if "/content" in path or "/text" in path:
            content = patch["v"] if isinstance(patch["v"], str) else ""

    return content


def _looks_like_search_json_fragment(text: str) -> bool:
    stripped = text.strip().lower()
    if not stripped.startswith("{"):
        return False
    if '"default"' in stripped and ('"questions"' in stripped or '"queries"' in stripped):
        return True
    return (
        '"queries"' in stripped
        or '"web"' in stripped
        or '"sources"' in stripped
        or '"citations"' in stripped
        or '"internal"' in stripped
        or '"questions"' in stripped
        or '"urls"' in stripped
    )


def _extract_search_data_from_json_text(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    extracted: dict[str, Any] = {"queries": [], "sources": [], "categories": []}
    _collect_search_metadata(parsed, extracted)
    return _dedupe_search_data(extracted)


def _clean_extracted_text(text: str) -> str:
    if not text:
        return ""
    in_lang_tag = [False]
    in_primary_attr = [False]
    cleaned = _strip_lang_tags(text, in_lang_tag)
    cleaned = _strip_primary_attr_fragments(cleaned, in_primary_attr)
    cleaned = _clean_notion_markup(cleaned)
    return cleaned.strip()


def _extract_text_from_value_items(value_items: Any) -> str:
    if not isinstance(value_items, list):
        return ""
    parts: list[str] = []
    for item in value_items:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "") or "").lower() != "text":
            continue
        content = item.get("content")
        if isinstance(content, str) and content:
            parts.append(content)
    return "".join(parts)


def _extract_markdown_chat_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
                continue
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type", "") or "").lower()
            if item_type == "text" and isinstance(item.get("content"), str):
                parts.append(str(item.get("content", "")))
                continue
            nested_value = item.get("value")
            if nested_value is not None:
                nested_text = _extract_markdown_chat_text(nested_value)
                if nested_text:
                    parts.append(nested_text)
        return "".join(parts)
    if isinstance(value, dict):
        for key in ("value", "content", "text"):
            if key in value:
                nested_text = _extract_markdown_chat_text(value.get(key))
                if nested_text:
                    return nested_text
    return ""


def _extract_markdown_chat_patch_text(patch: dict[str, Any]) -> tuple[str, str] | None:
    patch_op = str(patch.get("o", "") or "")
    patch_v = patch.get("v")
    if (
        patch_op == "a"
        and isinstance(patch_v, dict)
        and str(patch_v.get("type", "") or "").lower() == "markdown-chat"
    ):
        cleaned = _clean_extracted_text(_extract_markdown_chat_text(patch_v.get("value")))
        if cleaned:
            return ("final_content", cleaned)
    return None


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _extract_final_content_from_record_map(data: dict[str, Any]) -> dict[str, Any] | None:
    record_map = data.get("recordMap")
    if not isinstance(record_map, dict):
        return None

    thread_messages = record_map.get("thread_message")
    if not isinstance(thread_messages, dict):
        return None

    candidates: list[dict[str, Any]] = []
    for msg_id, msg_data in thread_messages.items():
        if not isinstance(msg_data, dict):
            continue
        outer_value = msg_data.get("value")
        if not isinstance(outer_value, dict):
            continue
        inner_value = outer_value.get("value")
        if not isinstance(inner_value, dict):
            continue
        step = inner_value.get("step")
        if not isinstance(step, dict):
            continue

        step_type = str(step.get("type", "") or "").lower()
        content = ""
        if step_type == "markdown-chat":
            content = _extract_markdown_chat_text(step.get("value"))
        elif step_type == "agent-inference":
            content = _extract_text_from_value_items(step.get("value"))
        elif step_type in {"text", "title"}:
            raw_value = step.get("value")
            if isinstance(raw_value, str):
                content = raw_value

        cleaned = _clean_extracted_text(content)
        if cleaned:
            candidates.append({
                "message_id": str(msg_id),
                "step_type": step_type or "unknown",
                "priority": FINAL_STEP_PRIORITIES.get(step_type, 100),
                "created_at": _safe_int(outer_value.get("created_time")),
                "edited_at": _safe_int(outer_value.get("last_edited_time")),
                "length": len(cleaned),
                "text": cleaned,
            })

    # 同时存在 text/markdown-chat 时忽略 agent-inference，避免重复
    high_priority_types = {"text", "markdown-chat"}
    has_high_priority = any(c["step_type"] in high_priority_types for c in candidates)
    if has_high_priority:
        candidates = [c for c in candidates if c["step_type"] in high_priority_types]

    if not candidates:
        return None

    best = max(
        candidates,
        key=lambda c: (
            int(c.get("priority", 0)),
            int(c.get("edited_at", 0)),
            int(c.get("created_at", 0)),
            int(c.get("length", 0)),
        ),
    )
    return {
        "text": str(best.get("text", "") or ""),
        "source_type": str(best.get("step_type", "") or "unknown"),
        "source_message_id": str(best.get("message_id", "") or ""),
        "source_length": int(best.get("length", 0)),
    }


def _classify_segment_type(effective_type: str) -> str:
    if not effective_type:
        return SEG_CONTENT
    if effective_type == "text":
        return SEG_CONTENT
    if effective_type == "title":
        return SEG_META
    if any(kw in effective_type for kw in _THINKING_TYPES):
        return SEG_THINKING
    if any(kw in effective_type for kw in _TOOL_TYPES):
        return SEG_TOOL
    return SEG_CONTENT


def _bind_pending_segment(
    notion_idx: int,
    pending: list[dict],
    segment_types: dict[int, str],
    value_types: dict[tuple[int, int], str],
    next_val_id: dict[int, int],
    patch_path: str,
) -> None:
    """从 pending 列表找最匹配的段落绑定到 Notion 真实 index（优先 thinking 段落）。"""
    if not pending:
        return
    val_idx = _extract_value_index(patch_path)
    best_idx = 0
    if val_idx is not None:
        for i, seg in enumerate(pending):
            vt = seg.get("value_types", {})
            if vt.get(val_idx) == SEG_THINKING:
                best_idx = i
                break
    chosen = pending.pop(best_idx)
    segment_types[notion_idx] = chosen["seg_class"]
    for vi, vc in chosen["value_types"].items():
        value_types[(notion_idx, vi)] = vc
    next_val_id[notion_idx] = chosen["next_val_id"]


def parse_stream(lines: Iterable[Any]) -> Generator[dict[str, Any], None, None]:
    """解析 Notion NDJSON 流，产出结构化事件：

      - {"type": "content",       "text": "..."}
      - {"type": "thinking",      "text": "..."}
      - {"type": "search",        "data": {...}}
      - {"type": "final_content", "text": "...", "source_type": "...", ...}

    段落注册表机制：o:"a" + path="/s/-" 的 patch 注册新顶层段落（v.type 标注类型），
    后续 o:"x" + "/s/N/..." 追加文本时查表确定归属，不靠关键词猜测。
    """
    in_lang_tag: list[bool] = [False]
    in_primary_attr: list[bool] = [False]
    search_json_buffer = ""
    search_json_depth = 0

    segment_types: dict[int, str] = {}
    value_types: dict[tuple[int, int], str] = {}
    next_val_id: dict[int, int] = {}
    _pending_segments: list[dict] = []

    for line in lines:
        if not line:
            continue
        if isinstance(line, bytes):
            line = line.decode("utf-8", errors="ignore")

        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        data_type = str(data.get("type", "") or "").lower()

        if data_type == "record-map":
            final_payload = _extract_final_content_from_record_map(data)
            if final_payload and final_payload.get("text"):
                yield {"type": "final_content", **final_payload}
            continue

        if data_type == "markdown-chat":
            cleaned = _clean_extracted_text(_extract_markdown_chat_text(data.get("value")))
            if cleaned:
                yield {"type": "final_content", "text": cleaned, "source_type": "markdown-chat-event"}
            continue

        if data_type != "patch":
            continue

        patches = data.get("v", [])
        if not isinstance(patches, list):
            continue

        for patch in patches:
            if not isinstance(patch, dict):
                continue

            patch_op = str(patch.get("o", "") or "")
            patch_v = patch.get("v")
            patch_path = _normalize_path(patch)
            patch_seg = _extract_segment_index(patch_path)

            markdown_chat_patch = _extract_markdown_chat_patch_text(patch)
            if markdown_chat_patch is not None:
                event_type, event_text = markdown_chat_patch
                if event_type == "final_content":
                    yield {"type": event_type, "text": event_text, "source_type": "markdown-chat-patch"}
                else:
                    yield {"type": event_type, "text": event_text}
                continue

            patch_type = str(patch.get("type", "") or "").lower()
            nested_type = ""
            if isinstance(patch_v, dict):
                nested_type = str(patch_v.get("type", "") or "").lower()
            effective_type = patch_type or nested_type

            path_stripped = patch_path.strip("/")
            is_new_toplevel_segment = (patch_op == "a" and path_stripped == "s/-")

            patch_role: str | None = None

            if is_new_toplevel_segment:
                seg_class = _classify_segment_type(effective_type)

                local_value_types: dict[int, str] = {}
                local_next_val_id = 0
                if isinstance(patch_v, dict) and "value" in patch_v:
                    value_array = patch_v.get("value")
                    if isinstance(value_array, list):
                        for idx, item in enumerate(value_array):
                            if isinstance(item, dict):
                                item_type = str(item.get("type", "") or "").lower()
                                item_class = _classify_segment_type(item_type)
                                local_value_types[idx] = item_class
                                local_next_val_id = idx + 1

                if 0 not in local_value_types:
                    local_value_types[0] = seg_class
                    local_next_val_id = max(local_next_val_id, 1)

                _pending_segments.append({
                    "seg_class": seg_class,
                    "value_types": local_value_types,
                    "next_val_id": local_next_val_id,
                })

                patch_role = local_value_types.get(0, seg_class)
                patch_seg = None

            elif patch_op == "a" and patch_seg is not None:
                if patch_seg not in segment_types and _pending_segments:
                    _bind_pending_segment(patch_seg, _pending_segments, segment_types, value_types, next_val_id, patch_path)

                if patch_seg not in segment_types:
                    segment_types[patch_seg] = _classify_segment_type(effective_type)

                value_add_idx = _extract_value_add_index(patch_path)
                if value_add_idx is not None:
                    vid = next_val_id.get(patch_seg, 0) if value_add_idx < 0 else value_add_idx
                    next_val_id[patch_seg] = max(next_val_id.get(patch_seg, 0), vid + 1)
                    val_class = _classify_segment_type(effective_type)
                    value_types[(patch_seg, vid)] = val_class
                    patch_role = val_class
                    in_lang_tag[0] = False
                    in_primary_attr[0] = False

            if patch_seg is not None and patch_seg not in segment_types and _pending_segments:
                _bind_pending_segment(patch_seg, _pending_segments, segment_types, value_types, next_val_id, patch_path)

            if patch_role is not None:
                seg_owner = patch_role
            else:
                val_idx = _extract_value_index(patch_path)
                if val_idx is not None and patch_seg is not None and (patch_seg, val_idx) in value_types:
                    seg_owner = value_types[(patch_seg, val_idx)]
                elif patch_seg is not None and patch_seg in segment_types:
                    seg_owner = segment_types[patch_seg]
                else:
                    seg_owner = SEG_CONTENT

            is_search_patch = _looks_like_search_patch(patch)
            if is_search_patch:
                search_data = _extract_search_data_from_patch(patch)
                if search_data:
                    yield {"type": "search", "data": search_data}

            if patch_op == "p" and "/content" in patch_path and isinstance(patch_v, str):
                if ">" in patch_v or "\n" in patch_v or "\r" in patch_v or not patch_v.strip():
                    in_lang_tag[0] = False
                    in_primary_attr[0] = False

            content = _extract_text_from_patch(patch)
            if not content:
                continue

            cleaned = _strip_lang_tags(content, in_lang_tag)
            cleaned = _strip_primary_attr_fragments(cleaned, in_primary_attr)
            cleaned = _clean_notion_markup(cleaned)
            if not cleaned:
                continue

            stripped = cleaned.strip()
            if stripped and (search_json_depth > 0 or _looks_like_search_json_fragment(stripped)):
                search_json_buffer += cleaned
                search_json_depth += stripped.count("{") - stripped.count("}")
                if search_json_depth <= 0:
                    sd = _extract_search_data_from_json_text(search_json_buffer)
                    if sd:
                        yield {"type": "search", "data": sd}
                    search_json_buffer = ""
                    search_json_depth = 0
                continue

            if is_search_patch:
                continue

            if seg_owner == SEG_META:
                continue
            if seg_owner in (SEG_THINKING, SEG_TOOL):
                yield {"type": "thinking", "text": cleaned}
            else:
                yield {"type": "content", "text": cleaned}


# ---------------------------------------------------------------------------
# 响应结果合并（对齐上游 _select_best_final_reply 的简化版）
# ---------------------------------------------------------------------------

def _select_best_final_reply(streamed_text: str, final_text: str, final_source_type: str) -> str:
    streamed = streamed_text or ""
    final = final_text or ""
    streamed_stripped = streamed.strip()
    final_stripped = final.strip()
    source = (final_source_type or "").strip().lower()

    if not final_stripped:
        return streamed
    if not streamed_stripped:
        return final
    if final.startswith(streamed):
        return final
    if streamed.startswith(final):
        if source == "title" or len(final_stripped) <= max(32, int(len(streamed_stripped) * 0.35)):
            return streamed
        return final

    if source == "title" and len(final_stripped) < max(48, int(len(streamed_stripped) * 0.6)):
        return streamed
    if len(final_stripped) >= max(48, int(len(streamed_stripped) * 0.6)):
        return final
    return streamed


@dataclass
class ChatResult:
    text: str
    thinking: str = ""
    search: list[dict[str, Any]] = field(default_factory=list)
    thread_id: str = ""
    streamed: str = ""


# ---------------------------------------------------------------------------
# 直连客户端
# ---------------------------------------------------------------------------

class NotionUpstreamError(RuntimeError):
    """Notion 上游请求失败或返回异常内容。"""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        retriable: bool = True,
        response_excerpt: str = "",
    ):
        super().__init__(message)
        self.status_code = status_code
        self.retriable = retriable
        self.response_excerpt = response_excerpt


class NotionDirect:
    def __init__(
        self,
        token_v2: str,
        space_id: str,
        user_id: str,
        space_view_id: str = "",
        user_name: str = "user",
        user_email: str = "",
        cookies: Optional[dict[str, str]] = None,
        notion_url: Optional[str] = None,
        client_version: Optional[str] = None,
        proxies: Optional[dict[str, str]] = None,
        runtime: Optional[str] = None,
        impersonate: Optional[str] = None,
    ):
        self.token_v2 = token_v2
        self.space_id = space_id
        self.user_id = user_id
        self.space_view_id = space_view_id
        self.user_name = user_name
        self.user_email = user_email
        self.notion_url = (notion_url or NOTION_URL).rstrip("/")
        self.client_version = client_version or NOTION_CLIENT_VERSION
        self.proxies = proxies if proxies is not None else _proxy_config()
        self.runtime = (runtime or NOTION_RUNTIME).strip().lower()
        self.impersonate = NOTION_IMPERSONATE if impersonate is None else impersonate

        self.cookies: dict[str, str] = dict(cookies or {})
        self.cookies["token_v2"] = self.token_v2

        self.inference_url = f"{self.notion_url}/api/v3/runInferenceTranscript"
        self.save_url = f"{self.notion_url}/api/v3/saveTransactions"

        self.current_thread_id: str = ""
        self._lock = threading.Lock()
        self._session = _new_http_session(self.impersonate, self.proxies)

    # -- 内部 ---------------------------------------------------------------

    def _make_session(self):
        return _new_http_session(self.impersonate, self.proxies)

    def _build_cookie_header(self) -> str:
        cookie_jar = dict(self.cookies)
        cookie_jar["notion_user_id"] = self.user_id
        return "; ".join(f"{name}={value}" for name, value in cookie_jar.items() if value)

    def _build_thread_headers(self) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "cookie": self._build_cookie_header(),
            "x-notion-active-user-header": self.user_id,
            "x-notion-space-id": self.space_id,
        }

    def _to_notion_transcript(self, transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
        converted: list[dict[str, Any]] = []
        for block in transcript:
            if block.get("type") != "config":
                converted.append(block)
                continue
            value = block.get("value")
            if not isinstance(value, dict):
                converted.append(block)
                continue
            notion_block = dict(block)
            notion_value = dict(value)
            mapped = get_notion_model(str(value.get("model", "") or ""))
            if mapped == "auto":  # auto 只存在于 agent_service 运行时
                mapped = get_notion_model("")
            notion_value["model"] = mapped
            notion_block["value"] = notion_value
            converted.append(notion_block)
        return converted

    def _resolve_thread_type(self, transcript: list[dict[str, Any]]) -> str:
        for block in transcript:
            if block.get("type") != "config":
                continue
            value = block.get("value")
            if isinstance(value, dict):
                thread_type = str(value.get("type", "") or "").strip()
                if thread_type:
                    return thread_type
        return "workflow"

    @staticmethod
    def _resolve_request_profile(thread_type: str) -> dict[str, Any]:
        is_markdown_chat = thread_type == "markdown-chat"
        return {
            "thread_type": thread_type,
            "create_thread": not is_markdown_chat,
            "is_partial_transcript": is_markdown_chat,
            "precreate_thread": is_markdown_chat,
            "include_debug_overrides": NOTION_DEBUG_OVERRIDES,
        }

    def _precreate_thread(self, thread_id: str, thread_type: str) -> bool:
        """markdown-chat 模型需要先用 saveTransactions 建 thread（用纯 requests）。"""
        payload = {
            "requestId": str(uuid.uuid4()),
            "transactions": [{
                "id": str(uuid.uuid4()),
                "spaceId": self.space_id,
                "operations": [{
                    "pointer": {"table": "thread", "id": thread_id, "spaceId": self.space_id},
                    "path": [],
                    "command": "set",
                    "args": {
                        "id": thread_id,
                        "version": 1,
                        "parent_id": self.space_id,
                        "parent_table": "space",
                        "space_id": self.space_id,
                        "created_time": int(time.time() * 1000),
                        "created_by_id": self.user_id,
                        "created_by_table": "notion_user",
                        "messages": [],
                        "data": {},
                        "alive": True,
                        "type": thread_type,
                    },
                }],
            }],
        }
        try:
            resp = requests.post(
                self.save_url, json=payload,
                headers=self._build_thread_headers(),
                timeout=20, proxies=self.proxies,
            )
            return resp.status_code == 200
        except Exception:
            return False

    def delete_thread(self, thread_id: str) -> bool:
        """把 thread 标记为 alive=False，从 Notion 主页面清掉对话记录。"""
        payload = {
            "requestId": str(uuid.uuid4()),
            "transactions": [{
                "id": str(uuid.uuid4()),
                "spaceId": self.space_id,
                "operations": [{
                    "pointer": {"table": "thread", "id": thread_id, "spaceId": self.space_id},
                    "command": "update",
                    "path": [],
                    "args": {"alive": False},
                }],
            }],
        }
        try:
            resp = requests.post(
                self.save_url, json=payload,
                headers=self._build_thread_headers(),
                timeout=15, proxies=self.proxies,
            )
            return resp.status_code == 200
        except Exception:
            return False

    # -- 核心直连 ------------------------------------------------------------

    def stream_transcript(
        self,
        transcript: list[dict[str, Any]],
        thread_id: Optional[str] = None,
    ) -> Generator[dict[str, Any], None, None]:
        """POST runInferenceTranscript，产出解析后的事件流。

        thread_id=None  → 新建 thread（本轮无服务端上下文）
        thread_id=已有  → 复用 thread，isPartialTranscript=True（服务端保留历史）
        注意：thread 的模型是粘性的，换模型必须传新的 thread_id（或 None）。
        """
        if not isinstance(transcript, list) or not transcript:
            raise ValueError("Invalid transcript payload: transcript must be a non-empty list.")

        if self.runtime == "agent_service":
            yield from self._stream_agent_service(transcript)
            return

        notion_transcript = self._to_notion_transcript(transcript)
        thread_type = self._resolve_thread_type(notion_transcript)
        request_profile = self._resolve_request_profile(thread_type)

        should_create_thread = thread_id is None
        thread_id = thread_id or str(uuid.uuid4())
        trace_id = str(uuid.uuid4())
        response = None

        self.current_thread_id = thread_id

        if request_profile["precreate_thread"] and should_create_thread:
            if not self._precreate_thread(thread_id, thread_type):
                request_profile["create_thread"] = True
                request_profile["is_partial_transcript"] = False
        elif not should_create_thread:
            request_profile["create_thread"] = False
            request_profile["is_partial_transcript"] = True

        # cookie 直接进 header，绕过 scraper 的 cookie jar（jar 可能被 Cloudflare
        # challenge 写入非 ASCII cookie 导致编码错误）
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/x-ndjson",
            "User-Agent": BROWSER_UA,
            "x-notion-space-id": self.space_id,
            "x-notion-active-user-header": self.user_id,
            "notion-audit-log-platform": "web",
            "notion-client-version": self.client_version,
            "origin": self.notion_url,
            "referer": f"{self.notion_url}/chat",
            "sec-ch-ua": _SEC_CH_UA,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "cookie": self._build_cookie_header(),
        }

        payload = {
            "traceId": trace_id,
            "spaceId": self.space_id,
            "threadId": thread_id,
            "threadType": thread_type,
            "createThread": request_profile["create_thread"],
            "generateTitle": True,
            "saveAllThreadOperations": True,
            "setUnreadState": True,
            "isPartialTranscript": request_profile["is_partial_transcript"],
            "asPatchResponse": True,
            "isUserInAnySalesAssistedSpace": False,
            "isSpaceSalesAssisted": False,
            "threadParentPointer": {
                "table": "space",
                "id": self.space_id,
                "spaceId": self.space_id,
            },
            "transcript": notion_transcript,
        }
        if request_profile["include_debug_overrides"]:
            payload["debugOverrides"] = {
                "emitAgentSearchExtractedResults": True,
                "cachedInferences": {},
                "annotationInferences": {},
                "emitInferences": False,
            }

        try:
            with self._lock:
                session = self._session
                session.cookies.clear()
            response = session.post(
                self.inference_url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=(15, 120),
            )
            if response.status_code == 403:
                # Cloudflare challenge 可能过期：重建 session 后重试一次
                response.close()
                new_session = self._make_session()
                with self._lock:
                    self._session = new_session
                response = new_session.post(
                    self.inference_url,
                    headers=headers,
                    json=payload,
                    stream=True,
                    timeout=(15, 120),
                )
            if response.status_code != 200:
                excerpt = (response.text or "").strip().replace("\n", " ")[:300]
                retriable = response.status_code >= 500 or response.status_code == 429
                raise NotionUpstreamError(
                    f"Notion upstream returned HTTP {response.status_code}.",
                    status_code=response.status_code,
                    retriable=retriable,
                    response_excerpt=excerpt,
                )

            emitted = False
            for chunk in parse_stream(response.iter_lines()):
                emitted = True
                yield chunk

            if not emitted:
                raise NotionUpstreamError(
                    "Notion upstream returned an empty stream.",
                    status_code=502,
                    retriable=True,
                )
        except _TIMEOUT_ERRORS as exc:
            raise NotionUpstreamError("Request to Notion upstream timed out.", retriable=True) from exc
        except _TRANSPORT_ERRORS as exc:
            raise NotionUpstreamError("Request to Notion upstream failed.", retriable=True) from exc
        finally:
            if response is not None:
                response.close()

    # -- agent_service 运行时（Notion 网页端 2026-10 起的协议） -----------------

    def _agent_headers(self, accept: str = "application/json") -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": accept,
            "User-Agent": BROWSER_UA,
            "x-notion-space-id": self.space_id,
            "x-notion-active-user-header": self.user_id,
            "notion-audit-log-platform": "web",
            "notion-client-version": self.client_version,
            "origin": self.notion_url,
            "referer": f"{self.notion_url}/ai",
            "sec-ch-ua": _SEC_CH_UA,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "cookie": self._build_cookie_header(),
        }

    @staticmethod
    def _rich_text_to_str(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, list) and item and isinstance(item[0], str):
                    parts.append(item[0])
                elif isinstance(item, dict):
                    parts.append(str(item.get("content") or item.get("text") or ""))
                elif isinstance(item, str):
                    parts.append(item)
            return "".join(parts)
        return ""

    def _transcript_to_agent_prompt(self, transcript: list[dict[str, Any]]) -> tuple[str, Optional[str]]:
        """把 transcript 摊平成一条 agent 消息：单轮直接发；多轮包 <conversation_history>。"""
        model: Optional[str] = None
        turns: list[tuple[str, str]] = []
        for block in transcript:
            btype = block.get("type")
            value = block.get("value")
            if btype == "config" and isinstance(value, dict):
                raw = str(value.get("model", "") or "")
                model = get_notion_model(raw) if raw else None
            elif btype == "user":
                text = self._rich_text_to_str(value)
                if text.strip():
                    turns.append(("user", text))
            elif btype in ("assistant", "agent-inference", "markdown-chat"):
                text = self._rich_text_to_str(value)
                if text.strip():
                    turns.append(("assistant", text))
        if not turns:
            raise ValueError("Transcript has no user message.")
        # 合并连续同角色轮次
        merged: list[list[str]] = []
        for role, text in turns:
            if merged and merged[-1][0] == role:
                merged[-1][1] += "\n\n" + text
            else:
                merged.append([role, text])
        if len(merged) == 1 and merged[0][0] == "user":
            return merged[0][1], model
        last_user_idx = max(i for i, (r, _) in enumerate(merged) if r == "user")
        history = merged[:last_user_idx]
        current = merged[last_user_idx][1]
        lines = ["<conversation_history>"]
        for role, text in history:
            lines.append(f"[{'User' if role == 'user' else 'Assistant'}]\n{text}\n")
        lines.append("</conversation_history>\n")
        lines.append("Continue the conversation above. Reply only to this latest user message:\n")
        lines.append(current)
        return "\n".join(lines), model

    def _agent_post(self, session, name: str, data: dict[str, Any], *, stream: bool = False, timeout: Any = 60):
        url = f"{self.notion_url}/api/v3/{name}"
        accept = "application/x-ndjson" if stream else "application/json"
        return session.post(url, headers=self._agent_headers(accept), json=data, stream=stream, timeout=timeout)

    def _agent_create_thread(self, session, thread_id: str, prompt: str, model: Optional[str]) -> str:
        payload: dict[str, Any] = {
            "type": "personal_agent",
            "spaceId": self.space_id,
            "threadId": thread_id,
            "createdSource": "full_page_chat",
            "content": [{"type": "text", "text": [[prompt]]}],
            "clientMessageId": str(uuid.uuid4()),
        }
        if model and model.lower() not in ("auto", "default"):
            payload["model"] = model
        resp = self._agent_post(session, "createAgentThread", payload, timeout=(15, 60))
        if resp.status_code == 400 and "model" in payload and "does not support selected model" in (resp.text or ""):
            # 该账号不支持所选模型：摘掉 model 以 Auto 重试（换新 threadId）
            payload.pop("model", None)
            payload["threadId"] = thread_id = str(uuid.uuid4())
            payload["clientMessageId"] = str(uuid.uuid4())
            resp = self._agent_post(session, "createAgentThread", payload, timeout=(15, 60))
        if resp.status_code != 200:
            excerpt = (resp.text or "").strip().replace("\n", " ")[:300]
            retriable = resp.status_code >= 500 or resp.status_code == 429
            raise NotionUpstreamError(
                f"Notion createAgentThread returned HTTP {resp.status_code}.",
                status_code=resp.status_code,
                retriable=retriable,
                response_excerpt=excerpt,
            )
        return thread_id

    def _stream_agent_service(self, transcript: list[dict[str, Any]]) -> Generator[dict[str, Any], None, None]:
        prompt, model = self._transcript_to_agent_prompt(transcript)
        thread_id = str(uuid.uuid4())
        session = _new_http_session(self.impersonate, self.proxies)
        response = None
        try:
            thread_id = self._agent_create_thread(session, thread_id, prompt, model)
            self.current_thread_id = thread_id
            response = self._agent_post(
                session,
                "listenToThreadTranscript",
                {
                    "spaceId": self.space_id,
                    "threadId": thread_id,
                    "includeProvisionalUserMessages": True,
                    "includeQueueChanges": False,
                },
                stream=True,
                timeout=(15, AGENT_SERVICE_TIMEOUT_S),
            )
            if response.status_code != 200:
                excerpt = (response.text or "").strip().replace("\n", " ")[:300]
                raise NotionUpstreamError(
                    f"Notion listenToThreadTranscript returned HTTP {response.status_code}.",
                    status_code=response.status_code,
                    retriable=response.status_code >= 500 or response.status_code == 429,
                    response_excerpt=excerpt,
                )
            yield from self._parse_agent_stream(response, thread_id)
        except _TIMEOUT_ERRORS as exc:
            raise NotionUpstreamError("Agent Service request timed out.", retriable=True) from exc
        except _TRANSPORT_ERRORS as exc:
            raise NotionUpstreamError("Request to Notion upstream failed.", retriable=True) from exc
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            try:
                session.close()
            except Exception:
                pass
            if AGENT_SERVICE_DELETE_THREAD and getattr(self, "current_thread_id", None) == thread_id:
                threading.Thread(target=self.delete_thread, args=(thread_id,), daemon=True).start()

    def _parse_agent_stream(self, response, thread_id: str) -> Generator[dict[str, Any], None, None]:
        """把 agent_service transcript delta 翻译成 content / thinking / final_content 事件。"""
        deadline = time.time() + AGENT_SERVICE_TIMEOUT_S
        provisional_text: dict[str, str] = {}  # assistant_message id -> 已发出的文本
        thinking_text: dict[str, str] = {}
        committed_assistant: list[str] = []
        emitted_any = False
        for raw in response.iter_lines():
            if time.time() > deadline:
                raise NotionUpstreamError("Agent Service turn timed out.", retriable=True)
            if not raw:
                continue
            line = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") != "agent_service_transcript_delta":
                continue
            for patch in event.get("patches") or []:
                op = patch.get("op")
                if op in ("session", "session_status"):
                    continue
                if op == "patch":
                    pid = str(patch.get("id") or "")
                    if pid not in provisional_text:
                        continue
                    for sub in patch.get("ops") or []:
                        if sub.get("op") == "append" and str(sub.get("path", "")).endswith("/text"):
                            delta = str(sub.get("value") or "")
                            if delta:
                                provisional_text[pid] += delta
                                emitted_any = True
                                yield {"type": "content", "text": delta}
                    continue
                if op != "put":
                    continue
                entity = patch.get("entity") or {}
                kind = entity.get("kind")
                source = entity.get("source")
                eid = str(entity.get("id") or "")
                if kind == "assistant_message":
                    text = "".join(
                        str(c.get("text") or "") for c in (entity.get("content") or [])
                        if isinstance(c, dict) and c.get("type") == "text"
                    )
                    if source == "provisional":
                        if eid not in provisional_text:
                            if any(provisional_text.values()) and text:
                                # 同一轮里的另一段回复（如工具调用之后）
                                yield {"type": "content", "text": "\n\n"}
                            provisional_text[eid] = ""
                        prev = provisional_text[eid]
                        delta = text[len(prev):] if text.startswith(prev) else text
                        if delta:
                            provisional_text[eid] = text
                            emitted_any = True
                            yield {"type": "content", "text": delta}
                    else:
                        if text:
                            committed_assistant.append(text)
                elif kind == "thinking":
                    text = str(entity.get("content_text") or "")
                    if source == "provisional" and text:
                        prev = thinking_text.get(eid, "")
                        delta = text[len(prev):] if text.startswith(prev) else text
                        thinking_text[eid] = text
                        if delta:
                            yield {"type": "thinking", "text": delta}
                elif kind == "turn_completed":
                    final = "\n\n".join(t for t in committed_assistant if t.strip())
                    if final:
                        yield {"type": "final_content", "text": final, "source_type": "agent-service-committed"}
                    elif not emitted_any:
                        raise NotionUpstreamError(
                            "Agent Service turn completed without an assistant message.",
                            status_code=502,
                            retriable=True,
                        )
                    return
                elif kind and ("error" in kind or "failed" in kind):
                    msg = str(entity.get("message") or entity.get("error") or entity.get("text") or kind)
                    raise NotionUpstreamError(
                        f"Notion Agent Service error: {msg}"[:300],
                        status_code=502,
                        retriable=False,
                    )
        # 流在 turn_completed 之前关闭
        final = "\n\n".join(t for t in committed_assistant if t.strip())
        if final:
            yield {"type": "final_content", "text": final, "source_type": "agent-service-committed"}
            return
        if not emitted_any:
            raise NotionUpstreamError("Agent Service stream ended without a reply.", status_code=502, retriable=True)

    def stream(
        self,
        prompt: str,
        history: Optional[list[dict[str, str]]] = None,
        *,
        model: str = DEFAULT_MODEL,
        system: str = "",
        thread_id: Optional[str] = None,
        timezone_name: str = "Asia/Shanghai",
    ) -> Generator[dict[str, Any], None, None]:
        """便捷入口：给定 prompt（+历史）直接产出事件流。

        agent_service 运行时：每次调用新建 thread，thread_id 参数被忽略（上下文靠
        history 摊平进单条 prompt）；legacy 运行时：thread_id 复用已有线程。
        """
        transcript = build_transcript(
            prompt, history,
            model=model, user_id=self.user_id, space_id=self.space_id,
            system=system, timezone_name=timezone_name,
        )
        yield from self.stream_transcript(transcript, thread_id=thread_id)

    def chat(
        self,
        prompt: str,
        history: Optional[list[dict[str, str]]] = None,
        *,
        model: str = DEFAULT_MODEL,
        system: str = "",
        thread_id: Optional[str] = None,
        timezone_name: str = "Asia/Shanghai",
    ) -> ChatResult:
        """一次性调用：消费完整事件流，返回最终文本 + thinking + 搜索来源 + thread_id。"""
        streamed = ""
        thinking = ""
        final_text = ""
        final_source = ""
        searches: list[dict[str, Any]] = []

        for ev in self.stream(
            prompt, history,
            model=model, system=system, thread_id=thread_id,
            timezone_name=timezone_name,
        ):
            ev_type = ev.get("type")
            if ev_type == "content":
                streamed += str(ev.get("text", "") or "")
            elif ev_type == "thinking":
                thinking += str(ev.get("text", "") or "")
            elif ev_type == "final_content":
                text = str(ev.get("text", "") or "").strip()
                if text:
                    final_text = text
                    final_source = str(ev.get("source_type", "") or "")
            elif ev_type == "search":
                data = ev.get("data")
                if isinstance(data, dict) and data:
                    searches.append(data)

        return ChatResult(
            text=_select_best_final_reply(streamed, final_text, final_source),
            thinking=thinking,
            search=searches,
            thread_id=self.current_thread_id,
            streamed=streamed,
        )


# ---------------------------------------------------------------------------
# 凭据解析：只凭 token_v2 拿到 space_id / user_id / space_view_id
# ---------------------------------------------------------------------------

def _safe_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        inner = value.get("value")
        if isinstance(inner, dict):
            return inner
        if inner is not None:
            return {"value": inner}
        return value
    return {}


def resolve_account(
    token_v2: str,
    cookies: Optional[dict[str, str]] = None,
    notion_url: Optional[str] = None,
    timeout: int = 30,
    proxies: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """用 token_v2 请求 loadUserContent，解析出账号四元组。token 无效会抛 ValueError。"""
    base = (notion_url or NOTION_URL).rstrip("/")
    cookie_values = dict(cookies or {})
    cookie_values["token_v2"] = token_v2
    active_user_id = str(cookie_values.get("notion_user_id") or "").strip()

    session = _new_http_session(NOTION_IMPERSONATE, proxies)
    session.headers.update({
        "Origin": base,
        "Referer": f"{base}/ai",
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json",
        "Cookie": "; ".join(f"{k}={v}" for k, v in cookie_values.items() if v),
    })
    resp = session.post(f"{base}/api/v3/loadUserContent", json={}, timeout=timeout)
    resp.raise_for_status()
    payload = resp.json()
    record_map = payload.get("recordMap") if isinstance(payload, dict) else None
    if not isinstance(record_map, dict):
        raise ValueError("loadUserContent 返回格式异常，token 可能无效。")

    users: dict[str, dict[str, str]] = {}
    for user_id, raw in (record_map.get("notion_user") or {}).items():
        v = _safe_value(raw)
        users[str(user_id)] = {
            "name": str(v.get("given_name") or v.get("name") or v.get("family_name") or "").strip(),
            "email": str(v.get("email") or "").strip(),
        }

    spaces: dict[str, dict[str, str]] = {}
    for space_id, raw in (record_map.get("space") or {}).items():
        v = _safe_value(raw)
        spaces[str(space_id)] = {"name": str(v.get("name") or "").strip()}

    space_views: dict[str, str] = {}
    for view_id, raw in (record_map.get("space_view") or {}).items():
        v = _safe_value(raw)
        space_id = str(v.get("space_id") or "").strip()
        if space_id:
            space_views.setdefault(space_id, str(view_id))

    if not users:
        raise ValueError("未解析到任何 Notion 用户，token_v2 可能无效或已过期。")
    if not spaces:
        raise ValueError("未解析到任何 workspace，token_v2 可能无效或已过期。")

    user_id = active_user_id if active_user_id in users else next(iter(users))
    space_id = next(iter(spaces))
    user = users[user_id]

    return {
        "profile_name": "default",
        "token_v2": token_v2,
        "space_id": space_id,
        "user_id": user_id,
        "space_view_id": space_views.get(space_id, ""),
        "user_name": user["name"] or "user",
        "user_email": user["email"],
        "cookies": cookies or {},
    }


def fetch_available_models(
    token_v2: str,
    space_id: str,
    user_id: str = "",
    notion_url: Optional[str] = None,
    client_version: Optional[str] = None,
    timeout: float = 30.0,
    proxies: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    """POST /api/v3/getAvailableModels，返回线上模型目录（防 codename 漂移）。

    当前 schema（2026-10）：body 必须带 spaceId；models[] 每项含 model / modelMessage /
    modelProvider。返回 [{codename, display, provider}]。
    """
    base = (notion_url or NOTION_URL).rstrip("/")
    session = _new_http_session(NOTION_IMPERSONATE, proxies)
    cookies = {"token_v2": token_v2}
    if user_id:
        cookies["notion_user_id"] = user_id
    session.headers.update({
        "Origin": base,
        "Referer": f"{base}/ai",
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "notion-client-version": client_version or NOTION_CLIENT_VERSION,
        "notion-audit-log-platform": "web",
        "x-notion-space-id": space_id,
        "x-notion-active-user-header": user_id,
        "Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items() if v),
    })
    resp = session.post(f"{base}/api/v3/getAvailableModels", json={"spaceId": space_id}, timeout=timeout)
    resp.raise_for_status()
    payload = resp.json()
    out: list[dict[str, Any]] = []
    for key in ("models", "restrictedAccessModelsInPickerConfig"):
        for item in (payload.get(key) if isinstance(payload, dict) else None) or []:
            if isinstance(item, dict) and isinstance(item.get("model"), str):
                out.append({
                    "codename": item["model"],
                    "display": str(item.get("modelMessage") or ""),
                    "provider": str(item.get("modelProvider") or item.get("modelFamily") or ""),
                })
            elif isinstance(item, str) and item.strip():
                out.append({"codename": item.strip(), "display": "", "provider": ""})
    return out


# ---------------------------------------------------------------------------
# CLI：凭据自检 / 模型目录校验 / 一次性问答
# ---------------------------------------------------------------------------

def _client_from_env(runtime: Optional[str] = None) -> NotionDirect:
    token = os.getenv("NOTION_TOKEN_V2", "").strip()
    if not token:
        raise SystemExit("缺少环境变量 NOTION_TOKEN_V2（token_v2 值）。")
    space_id = os.getenv("NOTION_SPACE_ID", "").strip()
    user_id = os.getenv("NOTION_USER_ID", "").strip()
    if not space_id or not user_id:
        raised = resolve_account(token)
        space_id = space_id or raised["space_id"]
        user_id = user_id or raised["user_id"]
    return NotionDirect(
        token_v2=token,
        space_id=space_id,
        user_id=user_id,
        space_view_id=os.getenv("NOTION_SPACE_VIEW_ID", "").strip(),
        user_name=os.getenv("NOTION_USER_NAME", "user").strip() or "user",
        user_email=os.getenv("NOTION_USER_EMAIL", "").strip(),
        runtime=runtime,
    )


def _main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Notion AI 直连（notion2api-next 抽离版）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="解析并打印 token_v2 对应的账号信息")
    sub.add_parser("models", help="拉取线上模型目录，比对本地图层 codename 是否漂移")

    ask = sub.add_parser("ask", help="一次性提问")
    ask.add_argument("prompt")
    ask.add_argument("--model", default=DEFAULT_MODEL, help=f"模型名（默认 {DEFAULT_MODEL}）")
    ask.add_argument("--thread", default=None, help="复用已有 thread_id（仅 legacy 运行时生效）")
    ask.add_argument("--runtime", default=None, choices=["agent_service", "legacy"], help="覆盖 NOTION_RUNTIME")
    ask.add_argument("--system", default="", help="system prompt（会被改写后并入首条消息）")
    ask.add_argument("--thinking", action="store_true", help="打印思考过程")

    args = parser.parse_args()

    if args.cmd == "check":
        token = os.getenv("NOTION_TOKEN_V2", "").strip()
        if not token:
            print("缺少环境变量 NOTION_TOKEN_V2。")
            print("获取方式：登录 notion.com 后，DevTools -> Application -> Cookies -> token_v2")
            return 1
        try:
            account = resolve_account(token)
        except Exception as exc:
            print(f"解析失败: {exc}")
            return 1
        print("token 有效，账号信息：")
        print(f"  token_v2: {token[:8]}...（已截断）")
        print(f"  user      : {account['user_name']} <{account['user_email']}>")
        print(f"  user_id   : {account['user_id']}")
        print(f"  space_id  : {account['space_id']}")
        print(f"  space_view: {account['space_view_id'] or '(无)'}")
        return 0

    if args.cmd == "models":
        client = _client_from_env()
        try:
            live = fetch_available_models(
                client.token_v2, client.space_id, client.user_id,
                client.notion_url, client.client_version, proxies=client.proxies,
            )
        except Exception as exc:
            print(f"拉取线上模型目录失败: {exc}")
            return 1
        known = set(MODEL_MAP.values())
        print(f"线上 {len(live)} 个模型（[OK ]=本地已映射，[NEW]=本地 MODEL_MAP 缺失）：")
        for rec in live:
            mark = "OK " if rec["codename"] in known else "NEW"
            print(f"  [{mark}] {rec['codename']:<38} {rec['display'] or rec['provider']}")
        missing = [r["codename"] for r in live if r["codename"] not in known]
        if missing:
            print(f"\n提示：{len(missing)} 个 codename 不在本地 MODEL_MAP，Notion 已漂移，需补映射。")
        else:
            print("\n本地 MODEL_MAP 与线上一致。")
        return 0

    if args.cmd == "ask":
        client = _client_from_env(runtime=args.runtime)
        try:
            result = client.chat(args.prompt, model=args.model, system=args.system, thread_id=args.thread)
        except NotionUpstreamError as exc:
            print(f"\n[上游错误] {exc} status={exc.status_code} excerpt={exc.response_excerpt}", flush=True)
            return 1
        if args.thinking and result.thinking:
            print(f"[thinking]\n{result.thinking}\n[/thinking]", flush=True)
        print(result.text)
        print(f"\n[thread_id] {result.thread_id}", flush=True)
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(_main())

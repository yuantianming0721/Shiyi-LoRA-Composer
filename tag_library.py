import json
import os

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
TAGS_DIR = os.path.join(HERE, "tags")
TAG_FILE = os.path.join(TAGS_DIR, "zh_CN.yaml")
STATIC_FILE = os.path.join(HERE, "web", "tags.json")

_cache = {"mtime": None, "data": None}


def _group(group):
    raw = group.get("tags") or {}
    tags = []
    if isinstance(raw, dict):
        for tag, zh in raw.items():
            tags.append({"tag": str(tag), "zh": str(zh or "")})
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                tags.append({"tag": item, "zh": ""})
    return {
        "name": str(group.get("name") or "未命名"),
        "color": str(group.get("color") or ""),
        "tags": tags,
    }


def load_tags():
    if not os.path.exists(TAG_FILE):
        return {"error": "tags/zh_CN.yaml 不存在", "total": 0, "categories": []}
    mtime = os.path.getmtime(TAG_FILE)
    if _cache["mtime"] == mtime:
        return _cache["data"]
    with open(TAG_FILE, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or []
    categories = []
    total = 0
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            groups = [_group(item) for item in (entry.get("groups") or []) if isinstance(item, dict)]
            groups = [item for item in groups if item["tags"]]
            if not groups:
                continue
            count = sum(len(item["tags"]) for item in groups)
            total += count
            categories.append(
                {"name": str(entry.get("name") or "未命名"), "count": count, "groups": groups}
            )
    data = {"file": "tags/zh_CN.yaml", "total": total, "categories": categories}
    _cache["mtime"] = mtime
    _cache["data"] = data
    return data


def sync_static():
    # 前端在旧后端（没有 /shiyi_lora/tags）时读这份静态快照
    data = load_tags()
    if data.get("error"):
        return
    if os.path.exists(STATIC_FILE) and os.path.getmtime(STATIC_FILE) >= os.path.getmtime(TAG_FILE):
        return
    with open(STATIC_FILE, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))

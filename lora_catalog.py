"""LoRA catalog + sidecar metadata reader.

Deliberately free of comfy imports so it can be exercised standalone:
    python lora_catalog.py <lora-name-substring>

Sidecar priority follows the local collection convention:
    <name>.txt              free-text description / weights / trigger words
    <name>.metadata.json    civitai trainedWords, base_model, tags
    <name>.png|jpeg|...     preview
    safetensors header      modelspec.* + ss_tag_frequency
"""

import json
import os
import re
import struct
import time

LORA_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".sft")
IMAGE_EXTS = (".png", ".preview.png", ".jpeg", ".jpg", ".webp", ".preview.jpg")

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
TRIGGERS_PATH = os.path.join(HERE, "triggers.json")

_SCAN_TTL = 30.0
_scan = {"stamp": 0.0, "items": [], "roots": []}
_info_cache = {}

_LINE_TRIGGER = re.compile(
    r"(?:触发词|觸發詞|trigger\s*words?|trigger\s*tags?|trigger|tags?\s*\([^)\n]*\))"
    r"\s*[:：]\s*(?P<rest>.+)",
    re.I,
)
_AT_TOKEN = re.compile(r"(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_\-]*(?:\s[A-Za-z][A-Za-z0-9_\-]*){0,2})")
_WORD_SPLIT = re.compile(r"[,，、;；\n]+")
_LABEL_LINE = re.compile(r"^\s*([^：:\n]{1,10})[：:]\s*(?P<rest>.+)$")
_TAG_LABEL_HINTS = ("触发", "特征", "人物", "角色", "服装", "衣服", "标签", "tag", "trigger")


def config_settings():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            cfg = {}
    except (OSError, ValueError):
        cfg = {}
    roots = [r for r in cfg.get("lora_roots") or [] if isinstance(r, str) and r.strip()]
    return {
        "lora_roots": roots,
        "default_strength": float(cfg.get("default_strength", 0.8)),
        "scan_ttl": float(cfg.get("scan_ttl", _SCAN_TTL)),
        "auto_trigger": bool(cfg.get("auto_trigger", True)),
    }


def load_triggers():
    """{lora 相对路径: 用户自己设定的触发词}"""
    try:
        with open(TRIGGERS_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items()}


def save_triggers(mapping):
    temp = TRIGGERS_PATH + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(mapping, handle, ensure_ascii=False, indent=1)
    os.replace(temp, TRIGGERS_PATH)


def _comfy_roots():
    try:
        import folder_paths
    except ImportError:
        return []
    try:
        return [p for p in folder_paths.get_folder_paths("loras") if p]
    except (KeyError, AttributeError, TypeError):
        return []


def get_roots():
    roots, seen = [], set()
    for root in _comfy_roots() + config_settings()["lora_roots"]:
        if not root or not os.path.isdir(root):
            continue
        key = os.path.normcase(os.path.abspath(root))
        if key in seen:
            continue
        seen.add(key)
        roots.append(os.path.abspath(root))
    return roots


def _relative(root, full):
    return os.path.relpath(full, root).replace("\\", "/")


def _scan_root(root, items, seen):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for filename in sorted(filenames):
            if not filename.lower().endswith(LORA_EXTS):
                continue
            full = os.path.join(dirpath, filename)
            key = os.path.normcase(os.path.abspath(full))
            if key in seen:
                continue
            seen.add(key)
            name = _relative(root, full)
            stem = os.path.splitext(full)[0]
            try:
                stat = os.stat(full)
                size, mtime = stat.st_size, stat.st_mtime
            except OSError:
                size, mtime = 0, 0.0
            items.append({
                "name": name,
                "label": os.path.splitext(filename)[0],
                "folder": name.rsplit("/", 1)[0] if "/" in name else "",
                "root": root.replace("\\", "/"),
                "path": full.replace("\\", "/"),
                "size": size,
                "mtime": mtime,
                "preview": any(os.path.exists(base + ext) for base in (stem, full) for ext in IMAGE_EXTS),
                "txt": any(os.path.exists(base + ".txt") for base in (stem, full)),
            })


def list_loras(force=False):
    settings = config_settings()
    ttl = settings["scan_ttl"]
    now = time.time()
    if not force and _scan["items"] and now - _scan["stamp"] < ttl:
        return _scan["items"], _scan["roots"]

    roots = get_roots()
    items, seen = [], set()
    for root in roots:
        _scan_root(root, items, seen)
    items.sort(key=lambda item: (item["folder"].lower(), item["label"].lower()))
    _scan.update(stamp=now, items=items, roots=[r.replace("\\", "/") for r in roots])
    return items, _scan["roots"]


def invalidate():
    """文件被外部改动（补图/补说明）后清缓存，下次扫描重新读盘。"""
    _scan["items"] = []
    _scan["stamp"] = 0
    _info_cache.clear()


def resolve_lora(name):
    """Map a name (relative to any root, either slash style) to an existing file."""
    if not name:
        return None
    cleaned = str(name).strip().replace("\\", "/").lstrip("./")
    if not cleaned:
        return None
    roots = get_roots()
    candidates = []
    if os.path.isabs(cleaned):
        candidates.append(os.path.normpath(cleaned))
    else:
        candidates.extend(os.path.normpath(os.path.join(root, cleaned)) for root in roots)
    for candidate in candidates:
        for root in roots:
            try:
                if os.path.commonpath([os.path.normcase(candidate), os.path.normcase(root)]) != os.path.normcase(root):
                    continue
            except ValueError:
                continue
            if os.path.isfile(candidate):
                return candidate
    return None


def split_words(value):
    out = []
    for chunk in _WORD_SPLIT.split(str(value or "")):
        word = chunk.strip().strip(".。 。").strip()
        if word:
            out.append(word)
    return out


def _dedupe(words):
    out, seen = [], set()
    for word in words:
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(word)
    return out


def _explicit_triggers(text):
    words = []
    for line in (text or "").splitlines():
        match = _LINE_TRIGGER.search(line)
        if match:
            words.extend(split_words(match.group("rest")))
    return words


def _at_triggers(text):
    return [match.group(1).strip() for match in _AT_TOKEN.finditer(text or "")]


def _looks_like_tags(value):
    if value.count(",") + value.count("，") < 2:
        return False
    ascii_chars = sum(1 for char in value if ord(char) < 128)
    return ascii_chars / max(1, len(value)) > 0.7


def _label_triggers(text):
    """`人物特征：a,b,c` / `服装：d,e` style sections, common in this collection."""
    strong, weak = [], []
    for line in (text or "").splitlines():
        match = _LABEL_LINE.match(line)
        if not match:
            continue
        rest = match.group("rest").strip()
        if not _looks_like_tags(rest):
            continue
        label = match.group(1).lower()
        if any(hint in label for hint in _TAG_LABEL_HINTS):
            strong.extend(split_words(rest))
        else:
            weak.extend(split_words(rest))
    return strong, weak


def _prompt_like_tags(text):
    """A bare tag list pasted as the whole description still yields clickable chips."""
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.count(",") >= 5 and _looks_like_tags(stripped):
            return split_words(stripped)
        return []
    return []


def _safetensors_metadata(path, limit=8 * 1024 * 1024):
    if not path.lower().endswith(".safetensors"):
        return {}
    try:
        with open(path, "rb") as handle:
            head = handle.read(8)
            if len(head) != 8:
                return {}
            header_len = struct.unpack("<Q", head)[0]
            if header_len <= 0 or header_len > limit:
                return {}
            blob = handle.read(header_len)
        header = json.loads(blob.decode("utf-8"))
    except (OSError, ValueError, struct.error):
        return {}
    meta = header.get("__metadata__")
    return meta if isinstance(meta, dict) else {}


def _tag_counts(meta, limit=30):
    """训练标签频次（按次数降序），供「取最高频当触发词」用。"""
    freq = meta.get("ss_tag_frequency")
    if isinstance(freq, str):
        try:
            freq = json.loads(freq)
        except ValueError:
            return []
    if not isinstance(freq, dict):
        return []
    totals = {}
    for bucket in freq.values():
        if not isinstance(bucket, dict):
            continue
        for tag, count in bucket.items():
            totals[tag] = totals.get(tag, 0) + (count if isinstance(count, int) else 0)
    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    return [[str(tag), int(count)] for tag, count in ranked[:limit] if str(tag).strip()]


def _top_tags(meta, limit=30):
    return [tag for tag, _ in _tag_counts(meta, limit)]


def _looks_like_tags(text):
    if "," not in text or not re.search(r"[A-Za-z]{2,}", text):
        return False
    return len([part for part in text.split(",") if part.strip()]) >= 2


def _is_heading(line):
    if len(line) > 40:
        return False
    if line.endswith(("：", ":")):
        return True
    # 「📋 提示」这类无冒号的短分隔行
    return len(line) <= 16 and not re.search(r"[A-Za-z]{4,}", line) and not any(c in line for c in ",，")


def _sections(text):
    """把 txt 拆成「标题 + 一段提示词」的可点击段落。"""
    lines = [line.rstrip() for line in str(text or "").splitlines()]
    out = []
    title = None
    buf = []

    def flush():
        nonlocal title, buf
        body = " ".join(part.strip() for part in buf if part.strip()).strip()
        if title is not None and body:
            is_trigger = "触发词" in title or "trigger" in title.lower()
            if is_trigger or _looks_like_tags(body):
                out.append(
                    {
                        "title": title,
                        "text": body,
                        "negative": "否定" in title or "negative" in title.lower(),
                    }
                )
        title = None
        buf = []

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if _is_heading(line):
            flush()
            title = line.rstrip("：: ").strip()
            continue
        if title is None:
            continue
        buf.append(line)
    flush()
    return out


def _sections_override(stem):
    path = stem + ".sections.json"
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        body = str(item.get("text") or "").strip()
        if not body:
            continue
        out.append(
            {
                "title": str(item.get("title") or "段落").strip(),
                "text": body,
                "negative": bool(item.get("negative")),
            }
        )
    return out


def read_info(name):
    path = resolve_lora(name)
    if not path:
        return {"name": name, "error": "not found in any lora root"}

    try:
        mtime = os.path.getmtime(path)
        size = os.path.getsize(path)
    except OSError:
        mtime, size = 0, 0
    cache_key = (path, mtime, size)
    cached = _info_cache.get(cache_key)
    if cached:
        return cached

    stem = os.path.splitext(path)[0]
    # 两种旁挂命名：xxx.txt（A1111/主流）与 xxx.safetensors.txt（整包分发的常见写法）
    sidecars = (stem, path)
    txt_path = next((base + ".txt" for base in sidecars if os.path.exists(base + ".txt")), stem + ".txt")
    meta_path = next(
        (base + ".metadata.json" for base in sidecars if os.path.exists(base + ".metadata.json")),
        stem + ".metadata.json",
    )

    description, notes, civitai = "", "", {}
    meta_json = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as handle:
                meta_json = json.load(handle)
            if not isinstance(meta_json, dict):
                meta_json = {}
        except (OSError, ValueError):
            meta_json = {}
    if os.path.exists(txt_path):
        try:
            with open(txt_path, "r", encoding="utf-8", errors="replace") as handle:
                description = handle.read().strip()
        except OSError:
            description = ""

    notes = str(meta_json.get("notes") or "").strip()
    model_description = str(meta_json.get("modelDescription") or "").strip()
    trained = meta_json.get("trainedWords")
    trained = [str(item) for item in trained if str(item).strip()] if isinstance(trained, list) else []

    header = _safetensors_metadata(path)
    header_description = str(header.get("modelspec.description") or "").strip()

    if not description:
        description = model_description or header_description

    explicit = _explicit_triggers(description)
    strong_labels, weak_labels = _label_triggers(description)
    at_tokens = _at_triggers(description)
    prompt_tags = _prompt_like_tags(description)
    trained_words = []
    for group in trained:
        trained_words.extend(split_words(group))

    candidates = _dedupe(
        trained_words + explicit + strong_labels + at_tokens + weak_labels + prompt_tags
    )
    if trained_words:
        source, primary = "trainedWords", trained_words
    elif explicit:
        source, primary = "txt", explicit
    elif strong_labels:
        source, primary = "txt", strong_labels
    elif at_tokens:
        source, primary = "txt", at_tokens
    else:
        source, primary = "none", []

    triggers = [word for word in _dedupe(primary) if len(word) <= 160][:6]

    base_model = str(meta_json.get("base_model") or "").strip()
    if base_model.lower() in ("", "unknown", "none"):
        base_model = str(header.get("ss_base_model_version") or header.get("modelspec.architecture") or "").strip()

    sections = _sections_override(stem)
    if sections is None:
        sections = _sections(description)

    info = {
        "name": str(name).replace("\\", "/"),
        "path": path.replace("\\", "/"),
        "label": os.path.splitext(os.path.basename(path))[0],
        "folder": _relative_root_folder(path),
        "size": size,
        "mtime": mtime,
        "preview": any(os.path.exists(base + ext) for base in sidecars for ext in IMAGE_EXTS),
        "has_txt": os.path.exists(txt_path),
        "base_model": base_model,
        "title": str(meta_json.get("model_name") or header.get("modelspec.title") or header.get("ss_output_name") or "").strip(),
        "source": "civitai" if meta_json.get("from_civitai") else "",
        "description": description,
        "notes": notes,
        "tags": meta_json.get("tags") if isinstance(meta_json.get("tags"), list) else [],
        "triggers": triggers,
        "candidates": candidates[:60],
        "trigger_source": source,
        "top_tags": _top_tags(header),
        "tag_counts": _tag_counts(header),
        "sections": sections,
    }
    if len(_info_cache) > 512:
        _info_cache.clear()
    _info_cache[cache_key] = info
    return info


def _relative_root_folder(path):
    for root in get_roots():
        try:
            if os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) != os.path.normcase(root):
                continue
        except ValueError:
            continue
        rel = _relative(root, path)
        return rel.rsplit("/", 1)[0] if "/" in rel else ""
    return ""


if __name__ == "__main__":
    import sys

    needle = sys.argv[1] if len(sys.argv) > 1 else ""
    entries, roots = list_loras(force=True)
    print("roots:", roots)
    print("total:", len(entries))
    hits = [e for e in entries if needle.lower() in e["name"].lower()]
    print("matched:", len(hits))
    for entry in hits[:5]:
        info = read_info(entry["name"])
        print("-" * 70)
        print("name      :", info["name"])
        print("base_model:", info.get("base_model"))
        print("source    :", info.get("trigger_source"))
        print("triggers  :", info.get("triggers"))
        print("top_tags  :", (info.get("top_tags") or [])[:10])
        print("desc      :", (info.get("description") or "")[:160].replace("\n", " / "))





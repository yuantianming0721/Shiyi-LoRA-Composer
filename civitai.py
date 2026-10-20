"""Civitai 补全：按文件哈希找模型，抓封面图和说明文本。"""

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

HASH_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "civitai_hashes.json")
API_ROOT = "https://civitai.com/api/v1"
DEFAULT_PROXY = "http://127.0.0.1:7890"
USER_AGENT = "Shiyi-LoRA-Composer/1.0"

_HASH_CACHE = None


def _load_hashes():
    global _HASH_CACHE
    if _HASH_CACHE is not None:
        return _HASH_CACHE
    data = {}
    if os.path.exists(HASH_CACHE_PATH):
        try:
            with open(HASH_CACHE_PATH, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            data = {}
    _HASH_CACHE = data
    return data


def _save_hashes():
    if _HASH_CACHE is None:
        return
    try:
        with open(HASH_CACHE_PATH, "w", encoding="utf-8") as handle:
            json.dump(_HASH_CACHE, handle, ensure_ascii=False, indent=1)
    except OSError:
        pass


def sha256_of(path):
    """整文件 SHA256，按 (path, size, mtime) 缓存，避免重复读几十 GB。"""
    try:
        stat = os.stat(path)
    except OSError:
        return ""
    key = path
    cached = _load_hashes().get(key)
    if cached and cached.get("size") == stat.st_size and cached.get("mtime") == stat.st_mtime:
        return cached.get("sha256", "")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    value = digest.hexdigest()
    _HASH_CACHE[key] = {"sha256": value, "size": stat.st_size, "mtime": stat.st_mtime}
    _save_hashes()
    return value


def _proxy():
    from . import lora_catalog

    settings = lora_catalog.config_settings()
    proxy = str(settings.get("civitai_proxy", DEFAULT_PROXY) or "").strip()
    return proxy or None


def _opener():
    proxy = _proxy()
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    opener.addheaders = [("User-Agent", USER_AGENT)]
    return opener


def _get_json(url, timeout=30):
    with _opener().open(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _plain(html):
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", str(html or ""))
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def lookup(path):
    """先按 AutoV2（前 10 位）查，再退回完整 SHA256。返回归一化信息或 None。"""
    digest = sha256_of(path)
    if not digest:
        return None
    for key in (digest[:10], digest):
        try:
            data = _get_json(f"{API_ROOT}/model-versions/by-hash/{key}")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                continue
            raise
        if data:
            return _normalize(data)
    return None


def _model_url(model_id, version_id):
    if model_id:
        return f"https://civitai.com/models/{model_id}?modelVersionId={version_id}"
    if version_id:
        return f"https://civitai.com/model-versions/{version_id}"
    return ""


def _normalize(data):
    model = data.get("model") or {}
    images = []
    for image in data.get("images") or []:
        url = image.get("url") or ""
        if not url:
            continue
        images.append(
            {
                "url": url,
                "nsfw_level": image.get("nsfwLevel", 0),
                "width": image.get("width", 0),
                "height": image.get("height", 0),
            }
        )
    images.sort(key=lambda item: (item["nsfw_level"] or 0, -(item["width"] or 0)))
    return {
        "model_id": model.get("id") or data.get("modelId"),
        "version_id": data.get("id"),
        "model_name": str(model.get("name") or "").strip(),
        "version_name": str(data.get("name") or "").strip(),
        "base_model": str(data.get("baseModel") or "").strip(),
        "trained_words": [str(word) for word in (data.get("trainedWords") or []) if str(word).strip()],
        "description": _plain(data.get("description")),
        "images": images,
        "url": _model_url(model.get("id") or data.get("modelId"), data.get("id")),
        "download_url": str(data.get("downloadUrl") or ""),
    }


def _best_image(info):
    if not info.get("images"):
        return None
    for image in info["images"]:
        if image.get("nsfw_level", 0) <= 1:
            return image
    return info["images"][0]


def download_cover(info, stem):
    image = _best_image(info)
    if not image:
        return None
    url = image["url"]
    if "width=" not in url:
        url = url + ("&" if "?" in url else "?") + "width=512"
    target = stem + ".png"
    with _opener().open(url, timeout=60) as response:
        payload = response.read()
    if not payload:
        return None
    with open(target, "wb") as handle:
        handle.write(payload)
    return target


def write_metadata(info, stem):
    path = stem + ".metadata.json"
    existing = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, ValueError):
            existing = {}
    existing.update(
        {
            "from_civitai": True,
            "model_name": info.get("model_name") or "",
            "modelId": info.get("model_id"),
            "modelVersionId": info.get("version_id"),
            "base_model": info.get("base_model") or "",
            "trainedWords": info.get("trained_words") or [],
            "modelDescription": info.get("description") or "",
            "civitai_url": info.get("url") or "",
            "source": "civitai",
        }
    )
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(existing, handle, ensure_ascii=False, indent=1)
    return path


def write_notes(info, stem):
    """写 <stem>.txt，段落格式匹配面板的 _sections 解析。"""
    path = stem + ".txt"
    blocks = []
    words = info.get("trained_words") or []
    if words:
        blocks.append("触发词：\n" + ", ".join(words))
    description = info.get("description") or ""
    if description:
        blocks.append(description)
    if not blocks:
        model_name = info.get("model_name") or ""
        version = info.get("version_name") or ""
        if model_name or version:
            blocks.append(f"模型：{model_name}\n版本：{version}")
    if not blocks:
        return None
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n\n".join(blocks).strip() + "\n")
    return path


def enrich(name, cover=True, notes=True, metadata=True):
    """给一个 LoRA 补封面 / 说明 / 元数据。返回结果字典。"""
    from . import lora_catalog

    path = lora_catalog.resolve_lora(name)
    if not path:
        return {"ok": False, "error": "找不到这个 LoRA"}
    stem = os.path.splitext(path)[0]
    info = lookup(path)
    if not info:
        return {"ok": False, "error": "Civitai 上查不到这个文件的哈希", "name": name}
    result = {"ok": True, "name": name, "found": {k: info.get(k) for k in ("model_name", "version_name", "base_model", "url")}, "written": []}
    lora_catalog.invalidate()
    has_txt = _has_sidecar(path, ".txt")
    has_preview = any(_has_sidecar(path, ext) for ext in (".png", ".jpeg", ".jpg", ".webp"))
    result["skipped"] = []
    if metadata:
        written = write_metadata(info, stem)
        result["written"].append(os.path.basename(written))
    if notes:
        if has_txt:
            result["skipped"].append("已有说明 txt，未覆盖")
        elif info.get("description") or info.get("trained_words"):
            written = write_notes(info, stem)
            if written:
                result["written"].append(os.path.basename(written))
    if cover:
        if has_preview:
            result["skipped"].append("已有预览图，未覆盖")
        else:
            try:
                written = download_cover(info, stem)
                if written:
                    result["written"].append(os.path.basename(written))
            except (urllib.error.URLError, OSError, ValueError) as error:
                result["cover_error"] = str(error)[:160]
    lora_catalog.invalidate()
    return result


def enrich_batch(names, limit=8):
    """逐个补，每两个之间停一下，避免触发 Civitai 的速率限制。"""
    from . import lora_catalog

    picked = [str(name) for name in (names or [])][:limit]
    done, failed = [], []
    for index, name in enumerate(picked):
        if index:
            time.sleep(1.0)
        try:
            result = enrich(name)
        except (urllib.error.URLError, OSError, ValueError) as error:
            result = {"ok": False, "name": name, "error": str(error)[:120]}
        if result.get("ok"):
            done.append({"name": name, "written": result.get("written") or []})
        else:
            failed.append({"name": name, "error": result.get("error") or "未命中"})
    lora_catalog.invalidate()
    return {"ok": True, "done": done, "failed": failed, "count": len(picked)}


def _has_sidecar(path, suffix):
    stem = os.path.splitext(path)[0]
    return any(os.path.exists(base + suffix) for base in (stem, path))


def missing_list(limit=500):
    """列出缺封面或说明的 LoRA（走扫描缓存，不重复读文件）。"""
    from . import lora_catalog

    items, _ = lora_catalog.list_loras()
    out = []
    for item in items:
        path = item.get("path") or ""
        if not path:
            continue
        has_txt = _has_sidecar(path, ".txt")
        has_preview = bool(item.get("preview"))
        if has_preview and has_txt:
            continue
        out.append(
            {
                "name": item.get("name"),
                "label": item.get("label"),
                "folder": item.get("folder"),
                "no_preview": not has_preview,
                "no_txt": not has_txt,
            }
        )
        if len(out) >= limit:
            break
    return out






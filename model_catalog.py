import json
import os
import struct

import folder_paths

CACHE = {}

_PRECISION = {
    "BF16": "bf16",
    "BFLOAT16": "bf16",
    "F16": "fp16",
    "FLOAT16": "fp16",
    "F32": "fp32",
    "FLOAT32": "fp32",
    "F8_E4M3": "fp8",
    "F8_E5M2": "fp8",
    "I8": "fp8",
    "U8": "fp8",
}

_ARCH_BY_TEXT = [
    ("krea", "Krea 2"),
    ("qwen", "Qwen-Image"),
    ("flux", "Flux"),
    ("chroma", "Chroma"),
    ("illustrious", "SDXL / Illustrious"),
    ("noob", "SDXL / NoobAI"),
    ("pony", "SDXL / Pony"),
    ("sdxl", "SDXL"),
    ("sd15", "SD1.5"),
    ("wan", "Wan"),
    ("ltx", "LTX"),
    ("hunyuan", "Hunyuan"),
    ("minimax", "MiniMax"),
    ("seedvr", "SeedVR"),
    ("moss", "MOSS"),
]

_PREVIEW_SUFFIXES = (".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp")


def _size_text(size):
    if size >= 1e9:
        return f"{size / 1e9:.2f} GB"
    if size >= 1e6:
        return f"{size / 1e6:.0f} MB"
    return f"{size / 1e3:.0f} KB"


def _safe_list(key):
    if key not in folder_paths.folder_names_and_paths:
        return []
    return list(folder_paths.get_filename_list(key))


def _full_path(kind, name):
    key = {"checkpoint": "checkpoints", "diffusion": "diffusion_models", "gguf": "unet_gguf"}[kind]
    path = folder_paths.get_full_path(key, name)
    if path:
        return path
    if kind != "gguf":
        return None
    for root in folder_paths.get_folder_paths("diffusion_models"):
        candidate = os.path.join(root, name.replace("/", os.sep))
        if os.path.exists(candidate):
            return candidate
    return None


def _gguf_names():
    names = _safe_list("unet_gguf")
    if names:
        return sorted(names)
    found = []
    for root in folder_paths.get_folder_paths("diffusion_models"):
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for filename in files:
                if filename.lower().endswith(".gguf"):
                    rel = os.path.relpath(os.path.join(dirpath, filename), root)
                    found.append(rel.replace("\\", "/"))
    return sorted(found)


def _read_safetensors(path):
    with open(path, "rb") as handle:
        head = handle.read(8)
        if len(head) < 8:
            return None
        length = struct.unpack("<Q", head)[0]
        if length <= 0 or length > 100_000_000:
            return None
        header = json.loads(handle.read(length))
    meta = header.pop("__metadata__", None) or {}
    counts = {}
    names = []
    for key, value in header.items():
        names.append(key)
        dtype = value.get("dtype")
        if dtype:
            counts[dtype] = counts.get(dtype, 0) + 1
    return meta, counts, names


def _read_gguf(path):
    import gguf

    reader = gguf.GGUFReader(path)
    counts = {}
    names = []
    for tensor in reader.tensors:
        names.append(tensor.name)
        try:
            label = gguf.GGMLQuantizationType(int(tensor.tensor_type)).name
        except ValueError:
            label = str(tensor.tensor_type)
        counts[label] = counts.get(label, 0) + 1
    fields = {}
    for key in ("general.architecture", "general.name"):
        if key in reader.fields:
            try:
                fields[key] = str(reader.fields[key].contents())
            except (TypeError, ValueError):
                pass
    return fields, counts, names


def _pick_precision(meta, counts):
    declared = meta.get("dtype_counts")
    if declared:
        try:
            parsed = json.loads(declared)
        except (TypeError, ValueError):
            parsed = None
        if parsed:
            top = max(parsed.items(), key=lambda item: item[1])[0].upper()
            return _PRECISION.get(top, top.lower())
    if counts:
        top = max(counts.items(), key=lambda item: item[1])[0]
        return _PRECISION.get(top, top)
    return "?"


def _arch_from_text(values):
    blob = " ".join(str(value) for value in values if value).lower()
    for needle, label in _ARCH_BY_TEXT:
        if needle in blob:
            return label
    return None


def _arch_from_tensors(names):
    joined = "\n".join(names)
    if "double_blocks." in joined or "single_blocks." in joined:
        return "Flux 系"
    if "label_emb." in joined:
        return "SDXL"
    if "input_blocks." in joined:
        return "SD1.x"
    if "transformer_blocks." in joined:
        return "SD3 / DiT 系"
    return None


def _assets_meta(path):
    manifest = os.path.join(path + ".assets", "manifest.json")
    if not os.path.exists(manifest):
        return {}
    try:
        with open(manifest, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return {
        "repo": str(data.get("repo") or ""),
        "component": str(data.get("component") or ""),
    }



_CLIP_PREFIXES = ("cond_stage_model.", "conditioner.", "clip_l.", "clip_g.", "te.", "text_encoders.", "text_model.")
_VAE_PREFIXES = ("first_stage_model.", "vae.")

_ARCH_CLIP_TYPE = [
    ("krea", "krea2"),
    ("qwen", "qwen_image"),
    ("flux", "flux"),
    ("chroma", "chroma"),
    ("moss", "moss_image"),
    ("ltx", "ltxv"),
    ("wan", "wan"),
    ("hunyuan", "hunyuan_image"),
    ("minimax", "minimax"),
    ("sd3", "sd3"),
    ("dit", "sd3"),
    ("sdxl", "stable_diffusion"),
    ("sd1", "stable_diffusion"),
]


def clip_type_for(arch, fallback="stable_diffusion"):
    blob = str(arch or "").lower()
    for needle, name in _ARCH_CLIP_TYPE:
        if needle in blob:
            return name
    return fallback


def _has_prefix(names, prefixes):
    return any(name.startswith(prefixes) for name in names)


def _entry(kind, name):
    path = _full_path(kind, name)
    if not path or not os.path.exists(path):
        return {"name": name, "kind": kind, "missing": True}
    stat = os.stat(path)
    cache_key = (path, stat.st_mtime_ns, stat.st_size)
    cached = CACHE.get(cache_key)
    if cached:
        return cached

    meta, counts, names = {}, {}, []
    if path.lower().endswith(".gguf"):
        meta, counts, names = _read_gguf(path)
    else:
        parsed = _read_safetensors(path)
        if parsed:
            meta, counts, names = parsed

    text_values = [
        meta.get("modelspec.architecture"),
        meta.get("modelspec.title"),
        meta.get("base_model"),
        meta.get("key_layout"),
        meta.get("converted_from"),
        meta.get("general.architecture"),
        os.path.basename(path),
    ]
    arch = _arch_from_text(text_values)
    arch_hint = "元数据"
    if not arch:
        arch = _arch_from_tensors(names)
        arch_hint = "按张量名推断"
    if not arch:
        arch = "未识别"
        arch_hint = "无可用特征"

    parts = name.replace("\\", "/").rsplit("/", 1)
    folder = parts[0] if len(parts) > 1 else ""
    entry = {
        "name": name,
        "kind": kind,
        "label": os.path.splitext(parts[-1])[0],
        "folder": folder,
        "format": "gguf" if path.lower().endswith(".gguf") else "safetensors",
        "size": stat.st_size,
        "size_text": _size_text(stat.st_size),
        "precision": _pick_precision(meta, counts),
        "arch": arch,
        "arch_hint": arch_hint,
        "tensors": len(names),
        "preview": find_preview(kind, name) is not None,
        "bundled_clip": _has_prefix(names, _CLIP_PREFIXES),
        "bundled_vae": _has_prefix(names, _VAE_PREFIXES),
        "clip_type": clip_type_for(arch),
    }
    entry.update(_assets_meta(path))
    CACHE[cache_key] = entry
    return entry


def find_preview(kind, name):
    path = _full_path(kind, name)
    if not path:
        return None
    stem = os.path.splitext(path)[0]
    candidates = [path + suffix for suffix in _PREVIEW_SUFFIXES]
    candidates += [stem + suffix for suffix in (".png", ".jpg", ".jpeg", ".webp")]
    assets = path + ".assets"
    candidates += [os.path.join(assets, item) for item in ("preview.png", "preview.jpg")]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def list_models():
    return {
        "checkpoint": [_entry("checkpoint", name) for name in _safe_list("checkpoints")],
        "diffusion": [_entry("diffusion", name) for name in _safe_list("diffusion_models")],
        "gguf": [_entry("gguf", name) for name in _gguf_names()],
        "clip": _safe_list("text_encoders") or _safe_list("clip"),
        "vae": _safe_list("vae"),
        "gguf_ready": "unet_gguf" in folder_paths.folder_names_and_paths,
    }




"""LoRA composer nodes: one node holds the whole LoRA stack, one encodes prompts."""

import json
import logging
import os
from collections import OrderedDict

import folder_paths
import comfy.sd
import comfy.utils

from . import model_catalog
from .lora_catalog import resolve_lora, split_words

LOGGER = logging.getLogger("ShiyiLoRA")
LOGGER.setLevel(logging.INFO)

_CACHE_MAX = 6
_lora_state_cache = OrderedDict()


def load_lora_state(path):
    try:
        key = (path, os.path.getmtime(path))
    except OSError:
        key = (path, 0)
    cached = _lora_state_cache.get(key)
    if cached is not None:
        _lora_state_cache.move_to_end(key)
        return cached
    state = comfy.utils.load_torch_file(path, safe_load=True)
    _lora_state_cache[key] = state
    while len(_lora_state_cache) > _CACHE_MAX:
        _lora_state_cache.popitem(last=False)
    return state


def _rows(stack_data):
    try:
        data = json.loads(stack_data or "[]")
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []


def _state_map(group_state):
    try:
        data = json.loads(group_state or "{}")
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def collect_words(grouped, group_state="{}"):
    """Accept `name<TAB>words` lines, or a flat comma list as a fallback."""
    state = _state_map(group_state)
    words = []
    for line in str(grouped or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if "\t" in line:
            name, _, payload = line.partition("\t")
            if state.get(name.strip()) is False:
                continue
            words.extend(split_words(payload))
        else:
            words.extend(split_words(line))
    return words


def merge_words(text, words, position="before", dedupe=True):
    text = text or ""
    words = [word for word in words if word]
    if not words:
        return text
    if dedupe:
        present = {tag.strip().lower() for tag in text.split(",") if tag.strip()}
        words = [word for word in words if word.lower() not in present]
        seen, unique = set(), []
        for word in words:
            if word.lower() in seen:
                continue
            seen.add(word.lower())
            unique.append(word)
        words = unique
    if not words:
        return text
    if position not in ("before", "after"):
        position = "before"
    extra = ", ".join(words)
    joined = f"{extra}, {text}" if position == "before" else f"{text}, {extra}"
    return joined.strip(", ").strip()


class ShiyiLoraStack:
    CATEGORY = "懒人/LoRA"
    FUNCTION = "apply"
    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "TRIGGERS", "TRIGGER_GROUPS")
    DESCRIPTION = "多 LoRA 编排器：单节点管理整条 LoRA 链，带说明面板与触发词输出。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",)},
            "optional": {
                "clip": ("CLIP",),
                "stack_data": ("STRING", {"default": "[]", "multiline": False}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, model=None, clip=None, stack_data="[]"):
        return stack_data

    def apply(self, model, clip=None, stack_data="[]"):
        triggers, groups = [], []
        for row in _rows(stack_data):
            if not isinstance(row, dict) or row.get("on") is False:
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            path = resolve_lora(name)
            if not path:
                LOGGER.warning("LoRA not found, skipped: %s", name)
                continue
            try:
                state = load_lora_state(path)
            except (OSError, RuntimeError, ValueError) as exc:
                LOGGER.warning("LoRA failed to load, skipped: %s (%s)", name, exc)
                continue
            model, clip = comfy.sd.load_lora_for_models(
                model,
                clip,
                state,
                float(row.get("sm", 1.0)),
                float(row.get("sc", 1.0)),
            )
            word = str(row.get("tw") or "").strip()
            if word:
                triggers.append(word)
                groups.append(f"{name}\t{word}")

        return (model, clip, merge_words("", collect_words("\n".join(triggers))), "\n".join(groups))


class ShiyiLoraClipEncode:
    CATEGORY = "懒人/LoRA"
    FUNCTION = "encode"
    RETURN_TYPES = ("CONDITIONING", "STRING")
    RETURN_NAMES = ("CONDITIONING", "PROMPT")
    DESCRIPTION = "CLIP 文本编码，接上游编排器的 TRIGGER_GROUPS 后可逐条勾选要并入的触发词。第二个输出是合并后的最终文本，可接其它需要提示词字符串的节点。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
            },
            "optional": {
                "triggers": ("STRING", {"default": "", "forceInput": True}),
                "group_state": ("STRING", {"default": "{}", "multiline": False}),
                # 旧工作流里存过空串，保留一个空选项让它能通过校验，执行时按 before 处理
                "position": (["before", "after", ""], {"default": "before"}),
                "dedupe": ("BOOLEAN", {"default": True}),
                # 只给前端反推用：接 LoadImage 的 IMAGE，反推按钮就知道该读哪张图
                "image": ("IMAGE",),
            },
        }

    def encode(self, clip, text, triggers="", group_state="{}", position="before", dedupe=True, image=None):
        words = collect_words(triggers, group_state)
        final = merge_words(text, words, position, dedupe)
        if clip is None:
            raise RuntimeError("clip 输入为空：请接 CLIP 或双 CLIP 加载器的输出")
        tokens = clip.tokenize(final)
        return (clip.encode_from_tokens_scheduled(tokens), final)


class ShiyiLoraPrompt:
    CATEGORY = "懒人/LoRA"
    FUNCTION = "merge"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("PROMPT",)
    DESCRIPTION = "把触发词并进提示词，去重后可选择放在正文前或正文后。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                "triggers": ("STRING", {"default": "", "forceInput": True}),
            },
            "optional": {
                "group_state": ("STRING", {"default": "{}", "multiline": False}),
                "position": (["before", "after"], {"default": "before"}),
                "dedupe": ("BOOLEAN", {"default": True}),
            },
        }

    def merge(self, text, triggers, group_state="{}", position="before", dedupe=True):
        words = collect_words(triggers, group_state)
        return (merge_words(text, words, position, dedupe),)



def _model_choices():
    data = model_catalog.list_models()
    choices = []
    for kind in ("checkpoint", "diffusion", "gguf"):
        for item in data[kind]:
            choices.append(f"[{kind}] {item['name']}")
    return choices or ["[checkpoint] 没有模型"]


def _clip_type_choices():
    names = [name.lower() for name in vars(comfy.sd.CLIPType) if not name.startswith("_")]
    return ["auto"] + (names or ["stable_diffusion"])


_KIND_KEY = {"checkpoint": "checkpoint", "diffusion": "diffusion", "gguf": "gguf"}


def _resolve_clip_type(kind, name, clip_type):
    if clip_type and clip_type != "auto":
        return clip_type
    entry = model_catalog._entry(_KIND_KEY.get(kind, kind), name)
    return entry.get("clip_type") or "stable_diffusion"


def _load_gguf(name):
    import nodes as comfy_nodes

    loader = comfy_nodes.NODE_CLASS_MAPPINGS.get("UnetLoaderGGUF")
    if loader is None:
        raise RuntimeError("加载 .gguf 需要安装 ComfyUI-GGUF")
    return loader().load_unet(name)[0]


def _load_clip(name, clip_type):
    if not name or name == "none":
        return None
    path = folder_paths.get_full_path("text_encoders", name) or folder_paths.get_full_path("clip", name)
    if not path:
        raise FileNotFoundError(f"找不到文本编码器：{name}")
    ctype = getattr(comfy.sd.CLIPType, str(clip_type).upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
    return comfy.sd.load_clip(
        ckpt_paths=[path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=ctype,
    )


def _load_vae(name):
    if not name or name == "none":
        return None
    path = folder_paths.get_full_path("vae", name)
    if not path:
        raise FileNotFoundError(f"找不到 VAE：{name}")
    state, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    return comfy.sd.VAE(sd=state, metadata=metadata)


class ShiyiModelLoader:
    """按来源分派：完整 checkpoint / UNet(diffusion_models) / GGUF。"""

    CATEGORY = "懒人/模型"
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    DESCRIPTION = "懒人包：一个下拉选完整模型 / UNet / GGUF，面板显示缩略图、架构、精度、体积，输出 MODEL / CLIP / VAE"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (_model_choices(),),
                "clip_type": (_clip_type_choices(), {"default": "auto"}),
            },
            "optional": {
                "clip_name": (["none"] + model_catalog._safe_list("text_encoders"),),
                "vae_name": (["none"] + model_catalog._safe_list("vae"),),
            },
        }

    def load(self, model, clip_type="auto", clip_name="none", vae_name="none"):
        kind, _, name = str(model).partition("] ")
        kind = kind.lstrip("[").strip()
        ctype = _resolve_clip_type(kind, name, clip_type)
        if kind == "checkpoint":
            path = folder_paths.get_full_path("checkpoints", name)
            if not path:
                raise FileNotFoundError(f"找不到完整模型：{name}")
            loaded = comfy.sd.load_checkpoint_guess_config(
                path,
                output_vae=True,
                output_clip=True,
                embedding_directory=folder_paths.get_folder_paths("embeddings"),
            )
            model_obj, clip, vae = loaded[0], loaded[1], loaded[2]
            # 内置优先；内置缺的才用手选的
            if clip is None:
                clip = _load_clip(clip_name, ctype)
            if vae is None:
                vae = _load_vae(vae_name)
            return (model_obj, clip, vae)
        if kind == "diffusion":
            path = folder_paths.get_full_path("diffusion_models", name)
            if not path:
                raise FileNotFoundError(f"找不到 UNet：{name}")
            return (comfy.sd.load_diffusion_model(path), _load_clip(clip_name, ctype), _load_vae(vae_name))
        return (_load_gguf(name), _load_clip(clip_name, ctype), _load_vae(vae_name))



NODE_CLASS_MAPPINGS = {
    "ShiyiModelLoader": ShiyiModelLoader,
    "ShiyiLoraStack": ShiyiLoraStack,
    "ShiyiLoraClipEncode": ShiyiLoraClipEncode,
    "ShiyiLoraPrompt": ShiyiLoraPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ShiyiLoraStack": "懒人的 LoRA 编排器（多 LoRA · 说明 · 触发词）",
    "ShiyiLoraClipEncode": "懒人的 CLIP 文本编码（LoRA 触发词）",
    "ShiyiLoraPrompt": "懒人的触发词并入提示词",
    "ShiyiModelLoader": "懒人的模型加载器（Checkpoint / UNet / GGUF）",
}








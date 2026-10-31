"""HTTP routes for the composer UI (catalog list, per-lora info, preview image)."""

import asyncio
import base64
import json
import logging
import os
import time
import urllib.request
import uuid

import folder_paths
from aiohttp import web
from server import PromptServer

from .favorites import load_favorites, save_favorites
from .civitai import enrich, enrich_batch, missing_list
from .model_catalog import find_preview, list_models
from .tag_library import load_tags
from .lora_catalog import (
    IMAGE_EXTS,
    config_settings,
    list_loras,
    load_triggers,
    read_info,
    resolve_lora,
    save_triggers,
)

LOGGER = logging.getLogger("ShiyiLoRA")

OLLAMA_URL = os.environ.get("SHIYI_OLLAMA_URL", "http://127.0.0.1:11434")
VGL_CAPTION_SYSTEM = """You are a meticulous Visual Art Director. Analyze the image and output ONLY one valid JSON object, no markdown, no commentary.

Language rules:
- Field names stay English.
- Write descriptive text in Simplified Chinese: short_description, objects[].description, objects[].location, objects[].relationship, objects[].shape_and_color, objects[].texture, objects[].appearance_details, objects[].orientation, objects[].pose, objects[].expression, objects[].clothing, objects[].action, objects[].skin_tone_and_texture, background_setting, lighting.shadows, aesthetics.mood_atmosphere, context, edit_instruction.
- Keep categorical / technical values in English: style_medium, artistic_style, lighting.conditions, lighting.direction, aesthetics.composition, aesthetics.color_scheme, photographic_characteristics.depth_of_field, focus, camera_angle, lens_focal_length, objects[].relative_size, objects[].gender, text_render[].size, color, font.
- Use [] for text_render when there is no text.

Clothing vs bedding: a white fabric item with sleeves, cuffs, buttons, a collar, a hem or a garment opening is clothing; do not call it a pillow, blanket or bedding.

JSON keys: short_description, objects, background_setting, lighting, aesthetics, photographic_characteristics, style_medium, text_render, context, artistic_style.
Keep it compact: at most 3 objects, each description under 60 Chinese characters."""


VGL_SCHEMA = {
    "type": "object",
    "properties": {
        "short_description": {"type": "string", "minLength": 40, "maxLength": 400},
        "objects": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string", "minLength": 8},
                    "location": {"type": "string", "minLength": 2},
                    "relationship": {"type": "string", "minLength": 2},
                    "relative_size": {"type": "string", "enum": ["small", "medium", "large within frame"]},
                    "shape_and_color": {"type": "string", "minLength": 4},
                    "texture": {"type": "string", "minLength": 2},
                    "appearance_details": {"type": "string", "minLength": 4},
                    "orientation": {"type": "string", "minLength": 2},
                    "pose": {"type": "string"},
                    "expression": {"type": "string"},
                    "clothing": {"type": "string"},
                    "action": {"type": "string"},
                    "gender": {"type": "string"},
                    "skin_tone_and_texture": {"type": "string"},
                },
                "required": ["description", "location", "relationship", "relative_size", "shape_and_color", "texture", "appearance_details", "orientation"],
            },
        },
        "background_setting": {"type": "string", "minLength": 4},
        "lighting": {
            "type": "object",
            "properties": {
                "conditions": {"type": "string", "minLength": 2},
                "direction": {"type": "string", "minLength": 2},
                "shadows": {"type": "string", "minLength": 2},
            },
            "required": ["conditions", "direction", "shadows"],
        },
        "aesthetics": {
            "type": "object",
            "properties": {
                "composition": {"type": "string", "minLength": 2},
                "color_scheme": {"type": "string", "minLength": 2},
                "mood_atmosphere": {"type": "string", "minLength": 2},
            },
            "required": ["composition", "color_scheme", "mood_atmosphere"],
        },
        "photographic_characteristics": {
            "type": "object",
            "properties": {
                "depth_of_field": {"type": "string", "minLength": 2},
                "focus": {"type": "string", "minLength": 2},
                "camera_angle": {"type": "string", "minLength": 2},
                "lens_focal_length": {"type": "string", "minLength": 2},
            },
            "required": ["depth_of_field", "focus", "camera_angle", "lens_focal_length"],
        },
        "style_medium": {"type": "string", "enum": ["photograph", "digital illustration", "anime", "oil painting", "watercolor", "3D render", "pencil sketch", "pixel art", "vector art"]},
        "text_render": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "location": {"type": "string"},
                    "size": {"type": "string"},
                    "color": {"type": "string"},
                    "font": {"type": "string"},
                },
                "required": ["text", "location", "size", "color", "font"],
            },
        },
        "context": {"type": "string", "minLength": 8},
        "artistic_style": {"type": "string", "minLength": 3},
    },
    "required": [
        "short_description", "objects", "background_setting", "lighting", "aesthetics",
        "photographic_characteristics", "style_medium", "text_render", "context", "artistic_style",
    ],
}

VGL_STRUCTURE_SYSTEM = """Convert the English image description into a Fibo 2.0 VGL JSON caption.
Preserve every visual detail; do not summarize or omit colors, textures, clothing, pose, expression, lighting or background.
Write all descriptive values in Simplified Chinese. style_medium and artistic_style MUST be English enum values.
lighting.conditions is the light quality (e.g. warm golden window light), NOT depth of field. lighting.direction is where the light comes from. lighting.shadows is the shadow quality (soft / gentle / minimal), NOT depth of field. photographic_characteristics.depth_of_field is shallow/deep.
objects: at most 5 whole entities. For a person, describe the whole person once (never split into head/hands/tail/ears); put the outfit in `clothing`, body position in `pose`, facial expression in `expression`, what they are doing in `action`, gender in `gender`, skin in `skin_tone_and_texture`. For a person these fields are mandatory and must not be empty. Do not create separate objects for body parts or clothing. Fill every field: description, location, relationship, relative_size, shape_and_color, texture, appearance_details, orientation.
short_description: 40-100 Chinese characters, include subject + action + environment + lighting + mood.
context: one short phrase (<=20 Chinese characters) describing what the image is for, not a list or sentence.
Do not invent details that are not in the description. Use [] for text_render when there is no text."""


def _post_json(url, payload, timeout=30):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _ollama_chat(payload, timeout=180):
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _json(payload, status=200):
    return web.json_response(payload, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def _ollama_generate(payload, timeout=600):
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def register_routes():
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        LOGGER.warning("PromptServer not ready, LoRA composer routes skipped")
        return
    routes = instance.routes

    @routes.get("/shiyi_lora/list")
    async def shiyi_lora_list(request):
        force = request.rel_url.query.get("refresh") in ("1", "true", "yes")
        try:
            items, roots = list_loras(force=force)
        except OSError as exc:
            return _json({"error": str(exc), "loras": [], "roots": []}, 500)
        return _json({"loras": items, "roots": roots, "settings": config_settings()})

    @routes.get("/shiyi_lora/info")
    async def shiyi_lora_info(request):
        name = request.rel_url.query.get("name", "")
        try:
            return _json(read_info(name))
        except OSError as exc:
            return _json({"name": name, "error": str(exc)}, 500)

    @routes.get("/shiyi_lora/preview")
    async def shiyi_lora_preview(request):
        path = resolve_lora(request.rel_url.query.get("name", ""))
        if not path:
            return web.Response(status=404, text="not found")
        stem = os.path.splitext(path)[0]
        for ext in IMAGE_EXTS:
            if os.path.exists(stem + ext):
                return web.FileResponse(stem + ext)
        return web.Response(status=404, text="no preview")

    @routes.get("/shiyi_lora/missing")
    async def shiyi_lora_missing(request):
        limit = int(request.query.get("limit", "500"))
        items = missing_list(limit)
        return _json(
            {
                "count": len(items),
                "no_preview": sum(1 for item in items if item["no_preview"]),
                "no_txt": sum(1 for item in items if item["no_txt"]),
                "items": items,
            }
        )

    @routes.post("/shiyi_lora/enrich")
    async def shiyi_lora_enrich(request):
        payload = await request.json()
        return _json(enrich(str(payload.get("name") or "")))

    @routes.post("/shiyi_lora/enrich_batch")
    async def shiyi_lora_enrich_batch(request):
        payload = await request.json()
        return _json(enrich_batch(payload.get("names") or [], int(payload.get("limit", 8))))

    @routes.get("/shiyi_model/list")
    async def shiyi_model_list(request):
        return _json(list_models())

    @routes.get("/shiyi_model/preview")
    async def shiyi_model_preview(request):
        path = find_preview(request.query.get("kind", ""), request.query.get("name", ""))
        if not path:
            return web.Response(status=404, text="no preview")
        return web.FileResponse(path)

    @routes.get("/shiyi_lora/favorites")
    async def shiyi_lora_favorites_get(request):
        return _json(load_favorites())

    @routes.post("/shiyi_lora/favorites")
    async def shiyi_lora_favorites_post(request):
        return _json(save_favorites(await request.json()))

    @routes.get("/shiyi_lora/tags")
    async def shiyi_lora_tags(request):
        return _json(load_tags())

    @routes.get("/shiyi_lora/triggers")
    async def shiyi_lora_get_triggers(request):
        return _json(load_triggers())

    @routes.post("/shiyi_lora/vgl_caption")
    async def shiyi_lora_vgl_caption(request):
        try:
            body = await request.json()
        except ValueError:
            return _json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return _json({"error": "invalid body"}, 400)
        name = str(body.get("image") or "").strip()
        if not name:
            return _json({"error": "need image"}, 400)
        input_dir = os.path.abspath(folder_paths.get_input_directory())
        path = os.path.abspath(os.path.join(input_dir, name))
        if os.path.commonpath((input_dir, path)) != input_dir or not os.path.isfile(path):
            return _json({"error": f"参考图不存在：{name}"}, 400)
        if os.path.getsize(path) > 40 * 1024 * 1024:
            return _json({"error": "图片超过 40MB"}, 400)
        with open(path, "rb") as fh:
            image_b64 = base64.b64encode(fh.read()).decode("ascii")
        model = str(body.get("model") or "qwen3-vl:8b")
        slow = "30b" in model.lower()
        base_options = {"temperature": 0.2, "num_predict": 2500 if slow else 4096, "num_ctx": 8192 if slow else 12288}
        base_payload = {
            "model": model,
            "prompt": "Describe this image as JSON.",
            "system": VGL_CAPTION_SYSTEM,
            "images": [image_b64],
            "stream": False,
            "keep_alive": "5m",
            "options": base_options,
        }
        last_text = ""
        last_error = ""
        for attempt in range(2):
            payload = dict(base_payload)
            if attempt:
                payload["prompt"] = "Describe this image as JSON. Output only the JSON object."
                payload["options"] = {**base_options, "temperature": 0.1}
            try:
                data = await asyncio.to_thread(_ollama_generate, payload)
            except Exception as exc:
                last_error = f"Ollama 调用失败：{exc}"
                break
            text = str(data.get("response") or "").strip()
            if not text:
                last_error = f"模型返回空响应（done={data.get('done_reason')}, eval={data.get('eval_count')}）"
                continue
            last_text = text
            if text.startswith("```"):
                text = text.strip("`").strip()
                if text.lower().startswith("json"):
                    text = text[4:].strip()
            caption = None
            try:
                caption = json.loads(text)
            except ValueError:
                start, end = text.find("{"), text.rfind("}")
                if start >= 0 and end > start:
                    try:
                        caption = json.loads(text[start:end + 1])
                    except ValueError:
                        caption = None
            if isinstance(caption, dict):
                return _json({"ok": True, "caption": caption, "model": model, "attempts": attempt + 1})
            last_error = "模型没有返回合法 JSON"
        return _json({"error": last_error or "模型没有返回 JSON", "raw": last_text[-500:]}, 502)

    @routes.post("/shiyi_lora/joycaption")
    async def shiyi_lora_joycaption(request):
        try:
            body = await request.json()
        except ValueError:
            return _json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return _json({"error": "invalid body"}, 400)
        name = str(body.get("image") or "").strip()
        if not name:
            return _json({"error": "need image"}, 400)
        input_dir = os.path.abspath(folder_paths.get_input_directory())
        path = os.path.abspath(os.path.join(input_dir, name))
        if os.path.commonpath((input_dir, path)) != input_dir or not os.path.isfile(path):
            return _json({"error": f"参考图不存在：{name}"}, 400)
        graph = {
            "1": {"class_type": "LoadImage", "inputs": {"image": name}},
            "2": {"class_type": "JJC_DownloadAndLoadJoyCaptionModel", "inputs": {
                "model": "fancyfeast/llama-joycaption-beta-one-hf-llava",
                "memory_mode": "Maximum Savings (4-bit)",
                "keep_loaded": True,
            }},
            "3": {"class_type": "JJC_JoyCaption", "inputs": {
                "model": ["2", 0], "image": ["1", 0],
                "caption_type": "Straightforward", "caption_length": "long",
                "extra_option1": "Include information about lighting.",
                "extra_option2": "Include information about camera angle.",
                "extra_option3": "Include information on the image's composition style, such as leading lines, rule of thirds, or symmetry.",
                "extra_option4": "Specify the depth of field and whether the background is in focus or blurred.",
                "extra_option5": "", "person_name": "",
                "max_new_tokens": 512, "temperature": 0.6, "top_p": 0.9, "top_k": 0,
            }},
            "4": {"class_type": "PreviewAny", "inputs": {"source": ["3", 1]}},
        }
        base = f"http://{request.host}"
        try:
            queued = await asyncio.to_thread(
                _post_json, f"{base}/prompt",
                {"prompt": graph, "client_id": f"shiyi-joycaption-{uuid.uuid4().hex}"},
            )
        except Exception as exc:
            return _json({"error": f"提交 JoyCaption 任务失败：{exc}"}, 502)
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            return _json({"error": "JoyCaption 任务没有返回 id"}, 502)
        deadline = time.time() + 300
        while time.time() < deadline:
            await asyncio.sleep(1)
            try:
                hist = await asyncio.to_thread(_get_json, f"{base}/history/{prompt_id}")
            except Exception:
                continue
            entry = hist.get(prompt_id)
            if not entry:
                continue
            status = entry.get("status", {})
            if status.get("status_str") == "success":
                texts = (entry.get("outputs", {}).get("4", {}) or {}).get("text") or []
                text = str(texts[0]).strip() if texts else ""
                if text:
                    return _json({"ok": True, "caption": text})
                return _json({"error": "JoyCaption 没有返回文本"}, 502)
            if status.get("status_str") == "error":
                message = "JoyCaption 执行失败"
                for msg in status.get("messages", []):
                    if msg[0] == "execution_error":
                        message = msg[1].get("exception_message") or message
                return _json({"error": message}, 502)
        return _json({"error": "JoyCaption 超时"}, 504)

    @routes.post("/shiyi_lora/vgl_structure")
    async def shiyi_lora_vgl_structure(request):
        try:
            body = await request.json()
        except ValueError:
            return _json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return _json({"error": "invalid body"}, 400)
        text = str(body.get("text") or "").strip()
        if not text:
            return _json({"error": "need text"}, 400)
        model = str(body.get("model") or "qwen2.5:7b")
        translate_payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "Translate the English image description into Simplified Chinese. Preserve every visual detail. Output only the translation, no commentary."},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "keep_alive": "5m",
            "options": {"temperature": 0.1, "num_predict": 900, "num_ctx": 8192},
        }
        try:
            translated = await asyncio.to_thread(_ollama_chat, translate_payload)
        except Exception:
            translated = {}
        chinese = str((translated.get("message") or {}).get("content") or "").strip() or text
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": VGL_STRUCTURE_SYSTEM},
                {"role": "user", "content": chinese},
            ],
            "stream": False,
            "think": False,
            "format": VGL_SCHEMA,
            "keep_alive": "5m",
            "options": {"temperature": 0.1, "num_predict": 1800, "num_ctx": 8192},
        }
        try:
            data = await asyncio.to_thread(_ollama_chat, payload)
        except Exception as exc:
            return _json({"error": f"结构化模型调用失败：{exc}"}, 502)
        content = str((data.get("message") or {}).get("content") or "").strip()
        if not content:
            return _json({"error": "结构化模型返回空"}, 502)
        try:
            caption = json.loads(content)
        except ValueError:
            start, end = content.find("{"), content.rfind("}")
            caption = json.loads(content[start:end + 1]) if start >= 0 and end > start else None
        if not isinstance(caption, dict):
            return _json({"error": "结构化模型没有返回 JSON", "raw": content[:300]}, 502)
        return _json({"ok": True, "caption": caption, "model": model})

    @routes.post("/shiyi_lora/triggers")
    async def shiyi_lora_set_triggers(request):
        try:
            body = await request.json()
        except ValueError:
            return _json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return _json({"error": "invalid body"}, 400)
        store = load_triggers()
        patch = body.get("triggers")
        if isinstance(patch, dict):
            for name, words in patch.items():
                key = str(name).strip()
                if key:
                    store[key] = "" if words is None else str(words)
        elif body.get("name"):
            key = str(body["name"]).strip()
            if key:
                store[key] = "" if body.get("words") is None else str(body.get("words"))
        else:
            return _json({"error": "need name+words or triggers map"}, 400)
        try:
            save_triggers(store)
        except OSError as exc:
            return _json({"error": str(exc)}, 500)
        return _json({"ok": True, "count": len(store)})





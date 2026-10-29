"""HTTP routes for the composer UI (catalog list, per-lora info, preview image)."""

import asyncio
import base64
import json
import logging
import os
import urllib.request

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

JSON keys: short_description, objects, background_setting, lighting, aesthetics, photographic_characteristics, style_medium, text_render, context, artistic_style.
Keep it compact: at most 3 objects, each description under 60 Chinese characters."""


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





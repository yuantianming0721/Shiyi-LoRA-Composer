"""HTTP routes for the composer UI (catalog list, per-lora info, preview image)."""

import json
import logging
import os

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


def _json(payload, status=200):
    return web.json_response(payload, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


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





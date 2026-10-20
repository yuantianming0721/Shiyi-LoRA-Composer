import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FAV_FILE = os.path.join(HERE, "favorites.json")

_DEFAULT = {"categories": [{"name": "常用", "items": []}]}


def load_favorites():
    if not os.path.exists(FAV_FILE):
        return _DEFAULT
    with open(FAV_FILE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return _DEFAULT
    return {"categories": data.get("categories") or []}


def save_favorites(data):
    categories = []
    for cat in data.get("categories") or []:
        name = str(cat.get("name") or "").strip()
        if not name:
            continue
        items = []
        for item in cat.get("items") or []:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            label = str(item.get("name") or "").strip()
            items.append({"name": label or text.split("\n")[0][:24], "text": text})
        categories.append({"name": name, "items": items})
    payload = {"categories": categories}
    tmp = FAV_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, FAV_FILE)
    return payload

"""懒人的图片保存：命名、序号、子目录跟视频保存一套，PNG 还能把工作流写进去。"""

import json
import os

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from .video_save import NAMING_TEMPLATES, _fill, _next_index, _resolve_template, _safe_folder

IMAGE_FORMATS = {
    "png (无损)": {"ext": ".png", "lossy": False},
    "jpg (质量 0-100)": {"ext": ".jpg", "lossy": True},
    "webp (质量 0-100)": {"ext": ".webp", "lossy": True},
}


class ShiyiImageSave:
    CATEGORY = "懒人/输出"
    FUNCTION = "save"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    DESCRIPTION = "把 IMAGES 存成图片，命名支持日期/时间/自动序号，子目录可自定义，PNG 可内嵌工作流。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "naming": (list(NAMING_TEMPLATES.keys()), {"default": "日期+时间+序号"}),
                "filename": ("STRING", {"default": "{date}_{time}_{index}", "multiline": False,
                                        "tooltip": "选「自定义」时生效，可用 {date} {time} {datetime} {index}"}),
                "folder": ("STRING", {"default": "", "multiline": False,
                                      "tooltip": "留空 = output 根；填子目录名就挂在 output 下，支持 {date} 占位"}),
                "format": (list(IMAGE_FORMATS.keys()), {"default": "png (无损)"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100}),
                "embed": (["内嵌工作流+提示词", "内嵌工作流", "不内嵌"], {"default": "内嵌工作流+提示词"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def save(self, images, naming, filename, folder, format, quality, embed,
             prompt=None, extra_pnginfo=None):
        if not torch.is_tensor(images) or images.ndim != 4:
            raise ValueError("images 输入要求是 IMAGE 批次（张数 × 高 × 宽 × 通道）")

        spec = IMAGE_FORMATS[format]
        ext = spec["ext"]
        directory = _safe_folder(folder)
        template = _resolve_template(naming, filename)
        index = _next_index(directory, template, ext) if "{index}" in template else 1

        metadata = None
        if embed != "不内嵌" and ext == ".png":
            metadata = PngInfo()
            workflow = (extra_pnginfo or {}).get("workflow") if isinstance(extra_pnginfo, dict) else None
            if workflow:
                metadata.add_text("workflow", json.dumps(workflow, ensure_ascii=False))
            if embed == "内嵌工作流+提示词" and prompt:
                metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False))

        saved = []
        for offset, frame in enumerate(images):
            stem = _fill(template, index + offset)
            target = os.path.join(directory, stem + ext)
            array = (frame.detach().cpu().float().clamp(0.0, 1.0).numpy() * 255.0).round().astype(np.uint8)
            if array.ndim == 3 and array.shape[2] == 1:
                array = array[:, :, 0]
            image = Image.fromarray(array)
            if spec["lossy"] and image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            if ext == ".png" and metadata:
                image.save(target, pnginfo=metadata, compress_level=6)
            elif spec["lossy"]:
                image.save(target, quality=quality)
            else:
                image.save(target)
            saved.append(target)

        if not saved:
            raise RuntimeError("没有可保存的图片")

        total_mb = sum(os.path.getsize(path) for path in saved) / 1048576
        if len(saved) <= 4:
            listing = "、".join(os.path.basename(path) for path in saved)
        else:
            listing = f"{os.path.basename(saved[0])} … {os.path.basename(saved[-1])}"
        note = ""
        if embed != "不内嵌" and ext != ".png":
            note = " · 只有 png 能内嵌工作流"
        elif metadata is not None:
            note = " · 已内嵌工作流" if embed != "内嵌工作流+提示词" else " · 已内嵌工作流+提示词"
        summary = f"{listing}（{len(saved)} 张 · {total_mb:.1f} MB{note}）"
        return {"ui": {"text": [summary]}, "result": ()}


NODE_CLASS_MAPPINGS = {"ShiyiImageSave": ShiyiImageSave}
NODE_DISPLAY_NAME_MAPPINGS = {"ShiyiImageSave": "懒人的图片保存（时间 / 序号 / 内嵌工作流）"}

"""懒人的视频保存：命名、序号、子目录都替你算好，点运行就落盘。"""

import json
import os
import re
import subprocess
import tempfile
import wave

import numpy as np
import torch

import folder_paths
import imageio_ffmpeg

try:
    from comfy.utils import ProgressBar
except ImportError:  # 老版本没有进度条
    ProgressBar = None


NAMING_TEMPLATES = {
    "日期+时间+序号": "{date}_{time}_{index}",
    "日期+时间": "{date}_{time}",
    "日期+序号": "{date}_{index}",
    "时间+序号": "{time}_{index}",
    "日期": "{date}",
    "时间": "{time}",
    "自定义": None,
}

FORMATS = {
    "mp4 (h264)": {"ext": ".mp4", "video": ["-c:v", "libx264", "-pix_fmt", "yuv420p"], "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "mp4 (h265)": {"ext": ".mp4", "video": ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"], "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "webm (vp9)": {"ext": ".webm", "video": ["-c:v", "libvpx-vp9", "-b:v", "0", "-pix_fmt", "yuv420p"], "audio": ["-c:a", "libopus", "-b:a", "160k"]},
    "gif": {"ext": ".gif", "video": ["-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"], "audio": []},
}

_INDEX_RE = re.compile(r"^(\d{1,6})$")


def _stamp(fmt):
    import datetime

    now = datetime.datetime.now()
    return now.strftime(fmt)


def _safe_folder(folder):
    """只允许写进 output：相对路径挂到 output 下，跑出去了就拒绝。"""
    text = (folder or "").strip().replace("\\", "/")
    text = text.replace("{date}", _stamp("%Y-%m-%d")).replace("{time}", _stamp("%H-%M-%S")).replace("{datetime}", _stamp("%Y-%m-%d_%H-%M-%S"))
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError(f"保存文件夹不能包含 ..：{folder}")
    if os.path.isabs(text) or re.match(r"^[A-Za-z]:", text):
        raise ValueError(f"保存文件夹要填相对 output 的子目录，不要填绝对路径：{folder}")
    root = os.path.abspath(folder_paths.get_output_directory())
    target = os.path.abspath(os.path.join(root, *parts)) if parts else root
    if target != root and os.path.commonpath([root, target]) != root:
        raise ValueError(f"保存文件夹跑到 output 外面了：{folder}")
    os.makedirs(target, exist_ok=True)
    return target


def _resolve_template(naming, filename):
    template = NAMING_TEMPLATES.get(naming)
    if template is None:
        template = (filename or "").strip() or "{date}_{time}_{index}"
    return template


def _next_index(directory, template, ext):
    """同一模板下已有的最大序号 +1，让 0001、0002 接着往下排。"""
    pattern = re.escape(template).replace(re.escape("{index}"), r"(\d{1,6})")
    pattern = pattern.replace(re.escape("{date}"), r"\d{4}-\d{2}-\d{2}")
    pattern = pattern.replace(re.escape("{time}"), r"\d{2}-\d{2}-\d{2}")
    pattern = pattern.replace(re.escape("{datetime}"), r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}")
    matcher = re.compile("^" + pattern + re.escape(ext) + "$")
    if os.path.isdir(directory):
        current = [int(match.group(1)) for match in (matcher.match(name) for name in os.listdir(directory)) if match]
        if current:
            return max(current) + 1
    return 1


def _fill(template, index):
    text = template.replace("{date}", _stamp("%Y-%m-%d"))
    text = text.replace("{time}", _stamp("%H-%M-%S"))
    text = text.replace("{datetime}", _stamp("%Y-%m-%d_%H-%M-%S"))
    text = text.replace("{index}", f"{index:04d}")
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text or "video"


def _write_wav(audio, path):
    waveform = audio["waveform"]
    rate = int(audio["sample_rate"])
    if waveform.dim() == 3:
        waveform = waveform[0]
    samples = waveform.detach().cpu().float().clamp(-1.0, 1.0).numpy()
    if samples.ndim == 1:
        samples = samples[np.newaxis, :]
    channels = samples.shape[0]
    interleaved = (samples.T * 32767.0).astype("<i2").tobytes()
    with wave.open(path, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(interleaved)


class ShiyiVideoSave:
    CATEGORY = "懒人/输出"
    FUNCTION = "save"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    DESCRIPTION = "把 IMAGES 编码成视频，命名支持日期/时间/自动序号，子目录可自定义。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "naming": (list(NAMING_TEMPLATES.keys()), {"default": "日期+时间+序号"}),
                "filename": ("STRING", {"default": "{date}_{time}_{index}", "multiline": False,
                                        "tooltip": "选「自定义」时生效，可用 {date} {time} {datetime} {index}"}),
                "folder": ("STRING", {"default": "", "multiline": False,
                                      "tooltip": "留空 = output 根；填子目录名就挂在 output 下，支持 {date} 占位；绝对路径会被拒"}),
                "format": (list(FORMATS.keys()), {"default": "mp4 (h264)"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.1}),
                "quality": ("INT", {"default": 18, "min": 0, "max": 51}),
                "embed": (["内嵌工作流", "内嵌工作流+提示词", "不内嵌"], {"default": "内嵌工作流"}),
            },
            "optional": {
                "audio": ("AUDIO",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def save(self, images, naming, filename, folder, format, fps, quality, embed,
             audio=None, prompt=None, extra_pnginfo=None):
        if not torch.is_tensor(images) or images.ndim != 4:
            raise ValueError("images 输入要求是 IMAGE 批次（帧数 × 高 × 宽 × 通道）")

        spec = FORMATS[format]
        ext = spec["ext"]
        directory = _safe_folder(folder)
        template = _resolve_template(naming, filename)
        index = _next_index(directory, template, ext) if "{index}" in template else 1
        stem = _fill(template, index)
        target = os.path.join(directory, stem + ext)

        frames = images.detach().cpu().float().clamp(0.0, 1.0).numpy()
        height, width = frames.shape[1], frames.shape[2]
        if width % 2 or height % 2:
            width, height = width - width % 2, height - height % 2
            frames = frames[:, :height, :width]

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        command = [ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                   "-s", f"{width}x{height}", "-r", str(fps), "-i", "-"]

        audio_path = None
        if audio is not None and spec["audio"]:
            audio_path = os.path.join(tempfile.gettempdir(), f"shiyi_audio_{os.getpid()}.wav")
            _write_wav(audio, audio_path)
            command += ["-i", audio_path, "-shortest"]

        if format != "gif":
            command += spec["video"] + ["-crf", str(quality)]
        else:
            command += spec["video"]
        if audio_path and spec["audio"]:
            command += spec["audio"]

        embedded = 0
        unsupported = False
        if embed != "不内嵌" and spec["ext"] != ".mp4":
            # webm / gif 的容器不接受自定义元数据，干脆不假装内嵌了
            unsupported = True
        if embed != "不内嵌" and spec["ext"] == ".mp4":
            workflow = (extra_pnginfo or {}).get("workflow") if isinstance(extra_pnginfo, dict) else None
            if workflow:
                command += ["-metadata", "workflow=" + json.dumps(workflow, ensure_ascii=False)]
                embedded += 1
            if embed == "内嵌工作流+提示词" and prompt:
                command += ["-metadata", "prompt=" + json.dumps(prompt, ensure_ascii=False)]
                embedded += 1
            if spec["ext"] == ".mp4":
                command += ["-movflags", "+use_metadata_tags+faststart"]
        elif spec["ext"] == ".mp4":
            command += ["-movflags", "+faststart"]

        command += [target]

        bar = ProgressBar(len(frames)) if ProgressBar else None
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for frame in frames:
                process.stdin.write((frame * 255.0).astype(np.uint8).tobytes())
                if bar:
                    bar.update(1)
        finally:
            process.stdin.close()
            stderr = process.stderr.read().decode("utf-8", "replace")
            code = process.wait()
            process.stderr.close()
            if audio_path and os.path.exists(audio_path):
                os.remove(audio_path)

        if code != 0:
            raise RuntimeError(f"ffmpeg 编码失败（{code}）：{stderr.strip()[:500]}")
        if not os.path.exists(target):
            raise RuntimeError(f"ffmpeg 没生成文件：{target}")

        size_mb = os.path.getsize(target) / 1048576
        note = f" · 内嵌 {embedded} 项" if embedded else ""
        if unsupported:
            note = " · 该格式不支持内嵌工作流"
        summary = f"{target}（{len(frames)} 帧 · {width}x{height} · {size_mb:.1f} MB{note}）"
        return {"ui": {"text": [summary]}, "result": ()}


NODE_CLASS_MAPPINGS = {"ShiyiVideoSave": ShiyiVideoSave}
NODE_DISPLAY_NAME_MAPPINGS = {"ShiyiVideoSave": "懒人的视频保存（时间 / 序号 / 自定义文件夹）"}

import argparse
import json
import math
import re
from pathlib import Path

import av
import numpy as np
from PIL import Image


WORK_DIR = Path(
    r"E:\Drive\音声\[桃色みんと][RJ01562443] ❤️押しかけ同棲ギャル❤️ ダーリンに夢中なJKりおちゃんのドスケベ誘惑連発帰省ウィーク❤️ (CV 柚木つばめ)"
)
MP4_DIR = WORK_DIR / r"■08_おまけ『別言語(Multilingual)』\■02_簡体字(Simplified Chinese)\01. 簡中文字幕電影"
SCRIPT_DIR = WORK_DIR / r"■08_おまけ『別言語(Multilingual)』\■02_簡体字(Simplified Chinese)\02. 脚本"
AUDIO_DIR = WORK_DIR / r"■01_本編『音源』\■01_本編『SEありWAV』(おすすめ)"
WORK_CACHE = Path(r"E:\EXPERIMENT\Kikoeru\.subtitle_work\RJ01562443")


SEP_RE = re.compile(r"^-{5,}$")


def parse_script(track):
    path = SCRIPT_DIR / f"{track:02d}.txt"
    blocks = []
    cur = []
    for raw in path.read_text(encoding="utf-8-sig").replace("\r", "").split("\n"):
        line = raw.strip()
        if SEP_RE.match(line):
            if cur:
                blocks.append(cur)
                cur = []
            continue
        if line:
            cur.append(line)
    if cur:
        blocks.append(cur)
    return [{"jp": b[0], "zh": "\n".join(b[1:])} for b in blocks if len(b) >= 2]


def parse_srt(path):
    text = path.read_text(encoding="utf-8-sig").replace("\r", "")
    rows = []
    for block in re.split(r"\n\s*\n", text):
        lines = [x for x in block.split("\n") if x.strip()]
        if len(lines) < 3:
            continue
        m = re.search(r"(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)", block)
        if not m:
            continue
        rows.append({"start": parse_time(m.group(1)), "end": parse_time(m.group(2)), "lines": lines[2:]})
    return rows


def parse_time(value):
    h, m, rest = value.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def srt_time(value):
    value = max(0, value)
    ms = int(round(value * 1000))
    h = ms // 3600000
    ms %= 3600000
    m = ms // 60000
    ms %= 60000
    s = ms // 1000
    ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def subtitle_signature(frame):
    img = frame.to_image().convert("RGB")
    w, h = img.size
    crop = img.crop((int(w * 0.16), int(h * 0.73), int(w * 0.84), int(h * 0.96)))
    arr = np.asarray(crop, dtype=np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    white = (r > 188) & (g > 170) & (b > 170)
    pink = (r > 170) & (b > 125) & (g < 165) & ((r - g) > 35)
    mask = (white | pink).astype(np.uint8) * 255
    small = Image.fromarray(mask).resize((192, 40), Image.Resampling.BILINEAR)
    sig = (np.asarray(small, dtype=np.uint8) > 40).astype(np.uint8)
    density = float(sig.mean())
    return sig, density


def signature_diff(a, b):
    if a is None or b is None:
        return 1.0
    return float(np.mean(a != b))


def detect_segments(track, fps=3.0, min_density=0.006, change_threshold=0.018, min_gap=0.7):
    cache_path = WORK_CACHE / f"video_changes_{track:02d}_{fps:g}fps.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))

    mp4 = MP4_DIR / f"{track:02d}.mp4"
    container = av.open(str(mp4))
    stream = container.streams.video[0]
    next_sample = 0.0
    prev_sig = None
    active = False
    segments = []
    current = None

    for frame in container.decode(stream):
        t = float(frame.pts * stream.time_base)
        if t + 1e-6 < next_sample:
            continue
        sig, density = subtitle_signature(frame)
        has_text = density >= min_density
        diff = signature_diff(prev_sig, sig)

        if has_text and not active:
            current = {"start": t, "end": t, "density": density}
            active = True
        elif has_text and active:
            if diff >= change_threshold and current and (t - current["start"]) >= min_gap:
                current["end"] = t
                segments.append(current)
                current = {"start": t, "end": t, "density": density}
            else:
                current["end"] = t
                current["density"] = max(current["density"], density)
        elif (not has_text) and active:
            if current:
                current["end"] = t
                segments.append(current)
            current = None
            active = False

        prev_sig = sig
        next_sample = t + 1.0 / fps

    if active and current:
        segments.append(current)
    container.close()

    cleaned = []
    for seg in segments:
        if seg["end"] - seg["start"] < 0.35:
            continue
        if cleaned and seg["start"] - cleaned[-1]["end"] < 0.35:
            cleaned[-1]["end"] = seg["end"]
            cleaned[-1]["density"] = max(cleaned[-1]["density"], seg["density"])
        else:
            cleaned.append(seg)

    cache_path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    return cleaned


def align_by_sequence(track, segments, blend=0.15):
    script = parse_script(track)
    srt_path = sorted(AUDIO_DIR.glob(f"{track:02d}*.srt"))[0]
    old = parse_srt(srt_path)
    n = min(len(script), len(old))

    # If detection over-segments because of animation/noise, assign each cue to the nearest visual segment
    # by relative order, preserving duration shape from video when available.
    out = []
    for i in range(n):
        if segments:
            pos = i * (len(segments) - 1) / max(n - 1, 1)
            j = int(round(pos))
            v = segments[max(0, min(len(segments) - 1, j))]
            start = v["start"]
            end = v["end"]
        else:
            start = old[i]["start"]
            end = old[i]["end"]

        # Keep a little of the current ASR-aligned timing to avoid huge jumps when visual detection misses a cue.
        if abs(start - old[i]["start"]) > 8:
            start = old[i]["start"]
        else:
            start = start * (1 - blend) + old[i]["start"] * blend
        if abs(end - old[i]["end"]) > 8:
            end = old[i]["end"]
        else:
            end = end * (1 - blend) + old[i]["end"] * blend

        out.append({"start": start, "end": max(end, start + 0.45), "jp": script[i]["jp"], "zh": script[i]["zh"]})

    for i, cue in enumerate(out):
        if i + 1 < len(out) and cue["end"] > out[i + 1]["start"] - 0.08:
            cue["end"] = max(cue["start"] + 0.45, out[i + 1]["start"] - 0.08)
    return out


def write_srt(track, cues, suffix=".videoalign.srt"):
    out = AUDIO_DIR / (sorted(AUDIO_DIR.glob(f"{track:02d}*.wav"))[0].stem + suffix)
    lines = []
    for i, cue in enumerate(cues, 1):
        lines.extend([
            str(i),
            f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}",
            cue["jp"],
            cue["zh"],
            "",
        ])
    out.write_text("\n".join(lines), encoding="utf-8-sig")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tracks", nargs="+", type=int, default=[7])
    parser.add_argument("--fps", type=float, default=3.0)
    args = parser.parse_args()
    for track in args.tracks:
        segments = detect_segments(track, fps=args.fps)
        cues = align_by_sequence(track, segments)
        out = write_srt(track, cues)
        print(f"{track:02d}: video segments={len(segments)} cues={len(cues)} out={out}")


if __name__ == "__main__":
    main()

import argparse
import json
import re
import sys
from pathlib import Path

import av
import numpy as np
from PIL import Image


WORK_DIR = Path(
    r"E:\Drive\音声\[桃色みんと][RJ01562443] ❤️押しかけ同棲ギャル❤️ ダーリンに夢中なJKりおちゃんのドスケベ誘惑連発帰省ウィーク❤️ (CV 柚木つばめ)"
)
MP4_DIR = WORK_DIR / r"■08_おまけ『別言語(Multilingual)』\■02_簡体字(Simplified Chinese)\01. 簡中文字幕電影"
AUDIO_DIR = WORK_DIR / r"■01_本編『音源』\■01_本編『SEありWAV』(おすすめ)"
CACHE_DIR = Path(r"E:\EXPERIMENT\Kikoeru\.subtitle_work\RJ01562443")


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


def read_srt(path):
    rows = []
    text = path.read_text(encoding="utf-8-sig").replace("\r", "")
    for block in re.split(r"\n\s*\n", text):
        lines = [line for line in block.split("\n") if line.strip()]
        if len(lines) < 3:
            continue
        m = re.search(r"(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)", block)
        if not m:
            continue
        rows.append({"start": parse_time(m.group(1)), "end": parse_time(m.group(2)), "text": lines[2:]})
    return rows


def write_srt(path, rows):
    lines = []
    for i, row in enumerate(rows, 1):
        lines.append(str(i))
        lines.append(f"{srt_time(row['start'])} --> {srt_time(row['end'])}")
        lines.extend(row["text"])
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8-sig")


def subtitle_signature(frame):
    img = frame.to_image().convert("RGB")
    w, h = img.size
    crop = img.crop((int(w * 0.15), int(h * 0.72), int(w * 0.85), int(h * 0.965)))
    arr = np.asarray(crop, dtype=np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    white = (r > 188) & (g > 172) & (b > 172)
    pink = (r > 168) & (b > 120) & (g < 170) & ((r - g) > 28)
    mask = (white | pink).astype(np.uint8) * 255
    small = Image.fromarray(mask).resize((220, 48), Image.Resampling.BILINEAR)
    sig = (np.asarray(small, dtype=np.uint8) > 35).astype(np.uint8)
    return sig, float(sig.mean())


def diff_sig(a, b):
    if a is None or b is None:
        return 1.0
    return float(np.mean(a != b))


def scan_window(container, stream, start, end, fps):
    start = max(0.0, start)
    container.seek(int(start / stream.time_base), any_frame=False, backward=True, stream=stream)
    next_sample = start
    prev_sig = None
    active = False
    current = None
    segments = []
    for frame in container.decode(stream):
        t = float(frame.pts * stream.time_base)
        if t > end:
            break
        if t + 1e-6 < next_sample:
            continue
        sig, density = subtitle_signature(frame)
        has_text = density > 0.0055
        change = diff_sig(prev_sig, sig) > 0.022
        if has_text and not active:
            current = {"start": t, "end": t}
            active = True
        elif has_text and active:
            if change and current and t - current["start"] > 0.45:
                current["end"] = t
                segments.append(current)
                current = {"start": t, "end": t}
            else:
                current["end"] = t
        elif not has_text and active:
            if current:
                current["end"] = t
                segments.append(current)
            current = None
            active = False
        prev_sig = sig
        next_sample = t + 1.0 / fps
    if active and current:
        segments.append(current)
    return [s for s in segments if s["end"] - s["start"] >= 0.35]


def problem_runs(indexes):
    if not indexes:
        return []
    indexes = sorted(indexes)
    runs = [[indexes[0]]]
    for idx in indexes[1:]:
        if idx <= runs[-1][-1] + 1:
            runs[-1].append(idx)
        else:
            runs.append([idx])
    return runs


def fix_track(track, fps=5.0, padding=5.0):
    report_candidates = sorted(CACHE_DIR.glob(f"report_*_novad_*_{track:02d}.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not report_candidates:
        raise RuntimeError(f"no report for track {track:02d}")
    report = json.loads(report_candidates[0].read_text(encoding="utf-8"))
    low = [int(item["index"]) - 1 for item in report.get("low_coverage", [])]
    if not low:
        return None

    srt_path = sorted(AUDIO_DIR.glob(f"{track:02d}*.srt"))[0]
    rows = read_srt(srt_path)
    mp4 = MP4_DIR / f"{track:02d}.mp4"
    container = av.open(str(mp4))
    stream = container.streams.video[0]
    changed = []

    for run in problem_runs(low):
        old_start = min(rows[i]["start"] for i in run)
        old_end = max(rows[i]["end"] for i in run)
        segments = scan_window(container, stream, old_start - padding, old_end + padding, fps)
        if not segments:
            continue
        # Assign by order within the local window. If there are more visual segments than cues,
        # use the ones closest to current cue midpoints.
        if len(segments) >= len(run):
            chosen = []
            used = set()
            for i in run:
                mid = (rows[i]["start"] + rows[i]["end"]) / 2
                best = min(
                    [j for j in range(len(segments)) if j not in used],
                    key=lambda j: abs(((segments[j]["start"] + segments[j]["end"]) / 2) - mid),
                )
                used.add(best)
                chosen.append(segments[best])
            chosen.sort(key=lambda s: s["start"])
        else:
            chosen = []
            for pos, _ in enumerate(run):
                j = round(pos * (len(segments) - 1) / max(len(run) - 1, 1))
                chosen.append(segments[j])

        for i, seg in zip(run, chosen):
            old_start = rows[i]["start"]
            old_end = rows[i]["end"]
            new_start = seg["start"] if abs(seg["start"] - old_start) <= padding + 1.5 else old_start
            new_end = max(seg["end"], new_start + 0.45) if abs(seg["end"] - old_end) <= padding + 1.5 else old_end
            prev_start = rows[i - 1]["start"] if i > 0 else -1
            next_start = rows[i + 1]["start"] if i + 1 < len(rows) else float("inf")
            if new_start > prev_start + 0.08 and new_start < next_start - 0.08 and new_end > new_start:
                rows[i]["start"] = new_start
                rows[i]["end"] = new_end
                if abs(new_start - old_start) > 0.04 or abs(new_end - old_end) > 0.04:
                    changed.append(i + 1)

    container.close()
    for i in range(len(rows) - 1):
        if rows[i]["end"] > rows[i + 1]["start"] - 0.06:
            rows[i]["end"] = max(rows[i]["start"] + 0.35, rows[i + 1]["start"] - 0.06)

    out_dir = CACHE_DIR / "targetfix_srt"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (srt_path.stem + ".targetfix.srt")
    write_srt(out, rows)
    return {"track": track, "report": report_candidates[0].name, "low": len(low), "changed": len(set(changed)), "out": str(out)}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--tracks", nargs="+", type=int, default=[7])
    parser.add_argument("--fps", type=float, default=5.0)
    parser.add_argument("--padding", type=float, default=5.0)
    args = parser.parse_args()
    for track in args.tracks:
        result = fix_track(track, fps=args.fps, padding=args.padding)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

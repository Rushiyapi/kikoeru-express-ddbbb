import argparse
import sys
import json
import os
import re
import wave
from difflib import SequenceMatcher
from pathlib import Path

from faster_whisper import WhisperModel


WORK_DIR = Path(
    r"E:\Drive\音声\[桃色みんと][RJ01562443] ❤️押しかけ同棲ギャル❤️ ダーリンに夢中なJKりおちゃんのドスケベ誘惑連発帰省ウィーク❤️ (CV 柚木つばめ)"
)
SCRIPT_DIR = WORK_DIR / r"■08_おまけ『別言語(Multilingual)』\■02_簡体字(Simplified Chinese)\02. 脚本"
AUDIO_DIR = WORK_DIR / r"■01_本編『音源』\■01_本編『SEありWAV』(おすすめ)"
DEFAULT_MODEL = "medium"
CUDNN_DIR = Path(r"C:\APP\ASMR & Manga\kikoeru-translate-win-x64-v0.6.7\cache\cudnn")
CACHE_DIR = Path(r"E:\EXPERIMENT\Kikoeru\.subtitle_work\RJ01562443")


PUNCT_RE = re.compile(r"[\s　、。．，,.!?！？…⋯・･「」『』（）()［］\[\]【】♪♡❤♥～~ー—\-:：;；\"'“”‘’]+")
SEPARATOR_RE = re.compile(r"^-{5,}$")


def normalize_text(text: str) -> str:
    return PUNCT_RE.sub("", text).lower()


def read_duration(audio_path: Path) -> float:
    with wave.open(str(audio_path), "rb") as wav:
        return wav.getnframes() / float(wav.getframerate())


def parse_script(script_path: Path, align_source: str):
    text = script_path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    blocks = []
    current = []
    for raw in text.split("\n"):
        line = raw.strip()
        if SEPARATOR_RE.match(line):
            if current:
                blocks.append(current)
                current = []
            continue
        if line:
            current.append(line)
    if current:
        blocks.append(current)

    cues = []
    for index, block in enumerate(blocks, start=1):
        if len(block) < 2:
            continue
        jp = block[0]
        zh = "\n".join(block[1:])
        normalized = normalize_text(jp if align_source == "jp" else zh) or normalize_text(zh) or normalize_text(jp)
        if not normalized:
            continue
        cues.append(
            {
                "index": index,
                "jp": jp,
                "zh": zh,
                "norm": normalized,
                "norm_start": None,
                "norm_end": None,
            }
        )
    return cues


def transcribe(audio_path: Path, model: WhisperModel, cache_path: Path, force: bool = False, vad_filter: bool = True):
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    segments_iter, info = model.transcribe(
        str(audio_path),
        language="ja",
        task="transcribe",
        beam_size=5,
        best_of=5,
        temperature=0,
        vad_filter=vad_filter,
        word_timestamps=True,
        condition_on_previous_text=True,
    )

    data = {
        "language": info.language,
        "duration": info.duration,
        "segments": [],
    }
    for segment in segments_iter:
        words = []
        for word in segment.words or []:
            words.append({"word": word.word, "start": word.start, "end": word.end})
        data["segments"].append(
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "words": words,
            }
        )

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def transcript_char_timeline(asr_data):
    chars = []
    times = []

    def append_piece(text, start, end):
        norm = normalize_text(text)
        if not norm:
            return
        start = float(start)
        end = float(end if end is not None else start)
        if end <= start:
            end = start + 0.08 * len(norm)
        span = end - start
        for i, ch in enumerate(norm):
            chars.append(ch)
            times.append((start + span * i / max(len(norm), 1), start + span * (i + 1) / max(len(norm), 1)))

    for segment in asr_data["segments"]:
        if segment.get("words"):
            for word in segment["words"]:
                append_piece(word["word"], word["start"], word["end"])
        else:
            append_piece(segment["text"], segment["start"], segment["end"])

    return "".join(chars), times


def build_script_text(cues):
    pieces = []
    cursor = 0
    for cue in cues:
        cue["norm_start"] = cursor
        pieces.append(cue["norm"])
        cursor += len(cue["norm"])
        cue["norm_end"] = cursor
    return "".join(pieces)


def map_script_to_transcript(script_text, transcript_text):
    matcher = SequenceMatcher(None, script_text, transcript_text, autojunk=False)
    raw_map = {}
    for a0, b0, size in matcher.get_matching_blocks():
        for offset in range(size):
            raw_map[a0 + offset] = b0 + offset
    return raw_map, matcher.ratio()


def interpolate_missing(cues, duration):
    anchors = [(i, cue["start"]) for i, cue in enumerate(cues) if cue.get("matched")]
    anchors_end = [(i, cue["end"]) for i, cue in enumerate(cues) if cue.get("matched")]

    for i, cue in enumerate(cues):
        if cue.get("matched"):
            continue
        prev_anchor = next(((j, t) for j, t in reversed(anchors) if j < i), None)
        next_anchor = next(((j, t) for j, t in anchors if j > i), None)
        if prev_anchor and next_anchor:
            j0, t0 = prev_anchor
            j1, t1 = next_anchor
            start = t0 + (t1 - t0) * (i - j0) / max(j1 - j0, 1)
        elif prev_anchor:
            j0, t0 = prev_anchor
            start = t0 + 2.0 * (i - j0)
        elif next_anchor:
            j1, t1 = next_anchor
            start = max(0.0, t1 - 2.0 * (j1 - i))
        else:
            start = duration * i / max(len(cues), 1)

        prev_end = next(((j, t) for j, t in reversed(anchors_end) if j < i), None)
        next_end = next(((j, t) for j, t in anchors_end if j > i), None)
        if prev_end and next_end:
            j0, t0 = prev_end
            j1, t1 = next_end
            end = t0 + (t1 - t0) * (i - j0) / max(j1 - j0, 1)
        else:
            end = start + max(1.2, min(6.0, len(cue["jp"]) * 0.12))

        cue["start"] = start
        cue["end"] = max(start + 0.8, end)
        cue["source"] = "interpolated"


def assign_times(cues, script_text, transcript_text, transcript_times, duration):
    char_map, ratio = map_script_to_transcript(script_text, transcript_text)

    for cue in cues:
        mapped = [
            char_map[pos]
            for pos in range(cue["norm_start"], cue["norm_end"])
            if pos in char_map and char_map[pos] < len(transcript_times)
        ]
        unique = sorted(set(mapped))
        coverage = len(unique) / max(len(cue["norm"]), 1)
        cue["coverage"] = coverage
        if len(unique) >= max(2, min(4, len(cue["norm"]) // 4)) and coverage >= 0.18:
            start = transcript_times[unique[0]][0]
            end = transcript_times[unique[-1]][1]
            cue["start"] = start
            cue["end"] = end
            cue["matched"] = True
            cue["source"] = "asr"
        else:
            cue["matched"] = False

    interpolate_missing(cues, duration)

    previous_end = 0.0
    for i, cue in enumerate(cues):
        next_start = cues[i + 1]["start"] if i + 1 < len(cues) else duration
        start = max(0.0, min(cue["start"] - 0.06, duration))
        end = max(cue["end"] + 0.16, start + 0.75)
        if start < previous_end - 0.15:
            start = max(0.0, previous_end - 0.05)
        if end > next_start + 0.6:
            end = max(start + 0.75, next_start - 0.05)
        cue["start"] = min(start, duration)
        cue["end"] = min(max(end, cue["start"] + 0.4), duration)
        previous_end = cue["end"]
    return ratio


def srt_time(value):
    value = max(0.0, float(value))
    total_ms = int(round(value * 1000))
    ms = total_ms % 1000
    total_seconds = total_ms // 1000
    seconds = total_seconds % 60
    total_minutes = total_seconds // 60
    minutes = total_minutes % 60
    hours = total_minutes // 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


def write_srt(cues, out_path: Path):
    lines = []
    for index, cue in enumerate(cues, start=1):
        lines.append(str(index))
        lines.append(f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}")
        lines.append(cue["jp"])
        lines.append(cue["zh"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8-sig")


def write_report(track_no, cues, ratio, report_path: Path):
    low = [cue for cue in cues if cue.get("coverage", 0) < 0.25]
    payload = {
        "track": track_no,
        "global_similarity": ratio,
        "cue_count": len(cues),
        "asr_matched": sum(1 for cue in cues if cue.get("source") == "asr"),
        "interpolated": sum(1 for cue in cues if cue.get("source") == "interpolated"),
        "low_coverage": [
            {
                "index": cue["index"],
                "coverage": round(cue.get("coverage", 0), 3),
                "start": round(cue["start"], 3),
                "end": round(cue["end"], 3),
                "jp": cue["jp"],
            }
            for cue in low
        ],
    }
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def safe_model_name(model_name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", model_name)


def process_track(track_no: int, model: WhisperModel, model_name: str, align_source: str, force_asr: bool = False, vad_filter: bool = True):
    script_path = SCRIPT_DIR / f"{track_no:02d}.txt"
    audio_path = sorted(AUDIO_DIR.glob(f"{track_no:02d}.*.wav"))[0]
    cues = parse_script(script_path, align_source)
    script_text = build_script_text(cues)
    duration = read_duration(audio_path)

    vad_label = "vad" if vad_filter else "novad"
    asr_path = CACHE_DIR / f"asr_{safe_model_name(model_name)}_{vad_label}_{track_no:02d}.json"
    asr_data = transcribe(audio_path, model, asr_path, force=force_asr, vad_filter=vad_filter)
    transcript_text, transcript_times = transcript_char_timeline(asr_data)
    ratio = assign_times(cues, script_text, transcript_text, transcript_times, duration)

    out_path = audio_path.with_suffix(".srt")
    write_srt(cues, out_path)

    report_path = CACHE_DIR / f"report_{safe_model_name(model_name)}_{vad_label}_{align_source}_{track_no:02d}.json"
    report = write_report(track_no, cues, ratio, report_path)
    return out_path, report


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--tracks", nargs="*", type=int, default=list(range(1, 11)))
    parser.add_argument("--force-asr", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--align-source", choices=["jp", "zh"], default="jp")
    parser.add_argument("--no-vad", action="store_true")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if CUDNN_DIR.exists():
        os.environ["PATH"] = str(CUDNN_DIR) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(CUDNN_DIR))
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    vad_filter = not args.no_vad

    for track_no in args.tracks:
        out_path, report = process_track(
            track_no,
            model,
            args.model,
            args.align_source,
            force_asr=args.force_asr,
            vad_filter=vad_filter,
        )
        print(
            f"{track_no:02d}: wrote {out_path.name}; "
            f"similarity={report['global_similarity']:.3f}; "
            f"cues={report['cue_count']}; "
            f"asr={report['asr_matched']}; interpolated={report['interpolated']}"
        )
        if report["low_coverage"]:
            vad_label = "vad" if vad_filter else "novad"
            print(
                f"  low coverage: {len(report['low_coverage'])} cues; "
                f"see {CACHE_DIR / f'report_{safe_model_name(args.model)}_{vad_label}_{args.align_source}_{track_no:02d}.json'}"
            )


if __name__ == "__main__":
    main()

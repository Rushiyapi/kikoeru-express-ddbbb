from pathlib import Path

import av


WORK_DIR = Path(
    r"E:\Drive\音声\[桃色みんと][RJ01562443] ❤️押しかけ同棲ギャル❤️ ダーリンに夢中なJKりおちゃんのドスケベ誘惑連発帰省ウィーク❤️ (CV 柚木つばめ)"
)
MP4_DIR = WORK_DIR / r"■08_おまけ『別言語(Multilingual)』\■02_簡体字(Simplified Chinese)\01. 簡中文字幕電影"
OUT_DIR = Path(r"E:\EXPERIMENT\Kikoeru\.subtitle_work\RJ01562443\video_samples")


def save_samples(track: int, times):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mp4 = MP4_DIR / f"{track:02d}.mp4"
    container = av.open(str(mp4))
    stream = container.streams.video[0]
    for t in times:
      container.seek(int(t / stream.time_base), any_frame=False, backward=True, stream=stream)
      for frame in container.decode(stream):
          seconds = float(frame.pts * stream.time_base)
          if seconds >= t:
              img = frame.to_image()
              img.save(OUT_DIR / f"{track:02d}_{int(t):04d}.jpg", quality=90)
              break
    container.close()
    print(OUT_DIR)


if __name__ == "__main__":
    save_samples(7, [20, 60, 120, 240, 420, 600])

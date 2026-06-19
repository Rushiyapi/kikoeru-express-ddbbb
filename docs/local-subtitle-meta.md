# 本地字幕元数据

第一阶段使用项目内的 `config/local-subtitle-meta.json` 集中记录字幕来源、对轴状态和音频显示标题。真实音频文件名不会被修改；Kikoeru 只在 `/api/tracks/:id` 返回给前端时替换显示标题。

## 文件位置

```text
E:\EXPERIMENT\Kikoeru\config\local-subtitle-meta.json
```

## 示例

```json
{
  "version": 1,
  "works": {
    "RJ01562443": {
      "preserveOriginalTitle": true,
      "separator": "｜",
      "subtitleStatus": {
        "textSource": "official_zh",
        "timingSource": "ai_aligned",
        "reviewStatus": "raw"
      },
      "workTitle": {
        "displayTitle": "押挂同居辣妹",
        "titleSource": "ai_translation"
      },
      "tracks": {
        "01. はじまり.wav": {
          "displayTitle": "01. 开始",
          "titleSource": "ai_translation"
        },
        "本編/02. 甘やかし.wav": {
          "displayTitle": "02. 撒娇陪伴",
          "titleSource": "ai_translation"
        }
      }
    }
  }
}
```

## 字段

- `subtitleStatus.textSource`
  - `official_zh`：中文文本来自官方中文脚本或官方中文资料。
  - `ai_translation`：中文文本由 AI 翻译或整理。
  - `manual_translation`：中文文本为人工翻译。
- `subtitleStatus.timingSource`
  - `ai_aligned`：时间轴由 AI 或自动化工具对齐。
  - `manual_aligned`：时间轴由人工对齐。
  - `official_timed`：时间轴来自官方字幕。
- `subtitleStatus.reviewStatus`
  - `raw`：未校对。
  - `checked`：已检查。
  - `proofread`：已校对。
- `tracks`：键为相对作品目录的原始文件路径，可以用 `/` 或 `\`。
- `displayTitle`：前端显示标题，不会重命名文件。
- `workTitle`：作品大标题的前端显示标题，不会修改数据库标题。
- `preserveOriginalTitle`：默认 `true`。音频标题会显示为 `中文｜日文原文件名`，作品详情页会在中文标题下方保留日文原题。
- `separator`：中文显示标题和原始音频标题之间的分隔符，默认 `｜`。

## 标题翻译风格

音频显示标题不是逐字机翻文件名，而是给播放器和作品列表看的中文标题。翻译时先看日文原文件名，再结合字幕或台本里的实际场景，最后重组为中文里读得通、能保留卖点的标题。

- 标题定稿前必须先查同轨可用内容：优先看已生成字幕、官方台本、LRC/SRT/VTT，必要时抽取开头、中段和标题相关段落。不能只凭文件名里的日文词逐字翻译。
- 如果文件名和实际音声内容侧重点不同，以实际音声内容决定中文标题的重心；文件名只作为卖点提示和检索依据。
- 术语优先按本地偏好统一。比如 `耳舐め` 在标题里优先译为“舔耳”，比“耳舔”更自然。
- 不要机械保留日文语序。日文标题常把动作、体位、结果压在一起，中文可以改成“场景 + 动作 + 结果”的顺序。
- 不要用过强的中文口语填充词。比如 `暇つぶしに` 可以译成“拿……打发时间”，不要默认写成“闲着没事”。
- `ために` 要按语境判断。成人音声标题里的 `お兄ちゃんのために` 多半是“为哥哥做某个色色服务”，不一定是郑重的“为了哥哥”；标题里常用“为哥哥”或“给哥哥”更贴切。
- 成人词要保留明确性，但避免生硬缩写或字幕组腔。比如 `喉奥射精` 可译为“深喉射精”；`汚喘ぎ` 不写“污喘”，按语境改成“喘着下流娇声”“下流喘叫”等更像中文标题。
- 系列或同类标题里的固定卖点要沿用本地既有译法。比如 `ハメ比べ` 优先译为“性爱比赛”，不要另造“抽插比试”等不统一说法。
- 如果标题后半句涉及体位、求婚、高潮等复合动作，要结合字幕内容重组。比如 `種付けプロポーズされながらイク` 不应硬写成“被种付求婚时高潮”，应改为“种付位做爱，一边高潮一边求婚”这类中文可读表达。
- 双关或造词不要硬拆。像 `チンかり` 这类卖点要结合字幕内容判断实际场景，可转成“安抚勃起的小弟弟”等可读标题，避免“一边借用肉棒”这种中文不成立的直译。

## 自动徽章

- `official_zh` + `ai_aligned` 显示为 `官中对轴`。
- `ai_translation` 显示为 `AI字幕`。
- 只有 `ai_aligned` 时显示为 `AI对轴`。
- `checked` 或 `proofread` 会额外显示 `已校对`。

也可以直接写 `badges` 覆盖自动文案：

```json
{
  "version": 1,
  "works": {
    "RJ01562443": {
      "badges": [
        {
          "label": "官中对轴",
          "description": "官方简中脚本，基于日文 WAV 自制时间轴"
        }
      ]
    }
  }
}
```

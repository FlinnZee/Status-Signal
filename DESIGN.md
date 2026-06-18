# PureSignal — Design & Engineering Notes

Technical reference for the encoding strategy and architecture. If the output ever regresses
to "soft" or "stuttery", re-read §3 — every parameter here exists for a reason that was
learned the hard way.

---

## 1. The strategy

WhatsApp re-encodes every Status video unconditionally to a small low-bitrate target for
global low-bandwidth delivery. The visible blur is the damage from a single, fast, low-effort
encoder making a huge jump (e.g. `1080p60 @ 17 Mbps → ~464x832 @ 630 kbps`) in one pass.

**Approach A — control where the lossy step happens.** Insert a high-effort, locally-controlled
encode *before* WhatsApp's pass. Pre-conform the video close to WhatsApp's target resolution but
at a deliberately higher bitrate, using a slow high-quality x264 encode. When WhatsApp then
re-encodes, it either near-passes-through or makes only a small jump — and because the
intermediate was encoded carefully, far more detail survives.

This is **not** a metadata trick. WhatsApp Status has no "premium ladder" to fake our way into.
The only real lever is controlling where the lossy step happens and how good it is. Two gentle
compressions beat one violent one.

**Correctness note:** WhatsApp's exact target spec *drifts* across app versions and between
iOS/Android. The numbers in §2 are a snapshot, stored as editable defaults — never hardcoded in
logic — and the app supports empirical recalibration (see §6).

---

## 2. Measured WhatsApp Status target (snapshot — 2026-06)

Obtained by posting a clip to Status, re-downloading it, and running ffprobe. These are the
numbers the default preset is calibrated against. They live in `config/defaults.json`, not in
code.

| Property      | Measured value                          |
|---------------|-----------------------------------------|
| Container     | mp4 (major_brand mp42/isom)             |
| Video codec   | H.264, **Baseline** profile, Level 3.1  |
| Resolution    | 464x832 (vertical 9:16-ish)             |
| B-frames      | 0 (Baseline; refs=1)                    |
| Framerate     | 30 fps                                  |
| GOP / keyint  | keyframe every 30 frames (~1s)          |
| Video bitrate | ~630 kbps                               |
| Pixel format  | yuv420p, BT.709, TV range               |
| Audio         | AAC-LC, stereo, 44.1 kHz, ~75 kbps      |

WhatsApp targets a *pixel+bitrate budget*, not a round resolution. 464x832 is what fits the
budget for a 9:16 source. Baseline + 0 B-frames means WhatsApp's own encode is weak — there is
real headroom for a better local encode to win.

---

## 3. The encoding recipe (core logic)

Use the **v2** recipe (§3.2). v1 (§3.5) is kept only so the reasoning isn't lost and we don't
regress to it.

### 3.1 The prototype bugs v2 fixes

1. **Frame dropping.** v1 used `-r 30` to take 60→30 fps. ffmpeg's `-r` does naive frame
   *dropping* (a test log showed `drop=678`), causing motion judder. v2's fix: **do not
   downconvert framerate at all by default — keep the source fps.** Smooth motion is half the
   perceived-quality gap.
2. **Bitrate starvation + pre-shrinking.** v1 pre-scaled to 720 short-edge at 1800 kbps. That
   handed WhatsApp a smaller, bit-starved source → visibly soft. v2 feeds full 1080 at ~6 Mbps
   so far more detail enters WhatsApp's pipeline and survives its final crush.

### 3.2 Default command — v2 (auto-detect orientation, keep source fps)

```
ffmpeg -y -i "INPUT" \
  -vf "scale='if(gt(a,1),-2,1080)':'if(gt(a,1),1080,-2)':flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -profile:v high -level 4.2 \
  -b:v 6000k -maxrate 8000k -bufsize 12000k \
  -x264-params "keyint=30:min-keyint=30:ref=4:bframes=3:aq-mode=3:aq-strength=1.0" \
  -c:a aac -b:a 192k -ar 44100 \
  -movflags +faststart \
  "OUTPUT"
```

**fps:** the command intentionally has NO `-r` and NO `fps` filter → source framerate is
preserved. If a future probe (§6) shows WhatsApp hard-caps fps and a source exceeds it, add
`fps=<cap>` to the filter chain (proper frame selection) — never `-r`.

**keyint:** `keyint=30` gives a ~1s GOP at 30fps sources; for 60fps it's a ~0.5s GOP, which is
fine (frequent keyframes survive re-encoding well).

### 3.3 Rationale for each parameter (mirrored in code comments)

- **scale auto-orient** — `a` is aspect ratio. Wider-than-tall → lock height 1080; else lock
  width 1080. `-2` keeps the other dimension proportional **and** even (H.264 requires even
  dims). We feed a full-1080 short-edge source, deliberately larger and richer than WhatsApp's
  ~464x832 output, so its own downscale starts from clean, detailed pixels.
- **flags=lanczos** — high-quality scaler, sharper than WhatsApp's cheap internal one.
- **framerate preserved** — no drop = no judder. Fixes the motion half of the quality gap.
- **preset slow (not veryslow)** — at ~6 Mbps, veryslow buys almost nothing visible and just
  wastes minutes. Detail comes from *bits*, not from a slower preset. veryslow optimizes file
  *size* at a target bitrate, not visible detail — a v1 misconception.
- **profile high + bframes=3** — the opposite of WhatsApp's Baseline. More efficient → more
  detail per bit.
- **b:v 6000k / maxrate 8000k** — ~10x WhatsApp's measured 630k output. This is an
  *intermediate* WhatsApp re-crushes; the goal is to hand it a detail-rich source, not to match
  its tiny target. Starving this stage (v1's 1800k) was the main cause of softness.
- **aq-mode=3** — distributes bits toward complex/detailed regions; sharper perceived result
  than v1's aq-mode=2.
- **keyint=30** — matches WhatsApp's 1s GOP so its re-encode aligns with our keyframes.
- **+faststart** — moov atom to the front; clean parse, no remux pass.

### 3.4 Input edge cases

- **HEVC / iPhone .mov** — decode fine; output is still H.264.
- **Cover-art / "Unknown cover type" warnings** — harmless, ignored.
- **Clips > 30s** — WhatsApp Status splits at 30s. The optional splitter cuts into ≤30s segments
  at keyframe boundaries (`-f segment -segment_time 30 -reset_timestamps 1`), each independently
  conformed.
- **Already-low-quality input** — warn the user; re-encoding garbage won't help.

### 3.5 v1 recipe (DEPRECATED — do not use, kept for context)

First prototype: 720 short-edge scale, `-r 30` framerate drop, `-preset veryslow`, `-b:v 1800k`,
`aq-mode=2`. Side-by-side testing showed output that looked **both softer and stuttery**. Root
causes: naive frame dropping (judder), pre-shrinking to 720 + only 1800k (bit starvation → soft),
and a wrong mental model that `veryslow` improves visible detail (it improves size efficiency at
a fixed bitrate, not detail). If output ever regresses to "soft/stuttery", check that none of
these v1 choices have crept back in.

---

## 4. Architecture

- **Tauri 2.x** — Rust backend + web frontend. Tiny binary, native drag-drop, systems-language
  backend.
- **Frontend** — vanilla HTML/CSS/JS (Vite). Dark, minimal, cyberpunk/terminal-adjacent.
- **ffmpeg** — bundled as a Tauri **sidecar** (zero setup on a new machine). Platform binaries
  live under `src-tauri/binaries/` and are declared as `externalBin`. Invoked via the shell
  plugin's sidecar API; progress parsed from `-progress pipe:1`. We do **not** rely on a system
  PATH ffmpeg.

**Rust side** owns the ffmpeg sidecar, runs the encode job, and streams progress events to the
frontend. ffmpeg is launched with `-progress pipe:1 -nostats`, which emits newline-delimited
`key=value` progress to stdout (`out_time_us`, `speed`, `frame`, …) — far more robust to parse
than the carriage-return stderr stats. Percent = `out_time_us / duration_us`, with duration read
from an ffprobe pass first.

**Frontend** — drag-drop zone, file queue, per-file progress bar, settings panel, output reveal.

All encode parameters live in a single Rust config struct plus the `config/defaults.json` file
(derived from §2/§3), so recalibration edits one place.

---

## 5. UI / UX

- Dark, minimal, high-contrast, cyberpunk/terminal-adjacent (monospace accents). Restrained
  motion — no gratuitous animation.
- **Primary flow:** big drag-drop target → drop file(s) → queue with progress → done state
  reveals the output file + "Open folder".
- Show source info on drop (resolution, fps, codec, bitrate, duration) so the user understands
  what they fed it.
- Collapsible **Advanced** panel: target bitrate, resolution cap, fps (keep source / 30), the
  splitter toggle. Defaults from §2 so casual use needs zero config.
- Clear non-blocking warnings ("source is already low bitrate", "clip > 30s, will split").
- Batch: accept multiple files, process sequentially, show overall progress.

---

## 6. Probe / Recalibration mode

Because WhatsApp's target drifts, recalibration is a first-class path:

1. **Probe** — the user drops a video that has *already been through WhatsApp Status* (posted then
   re-downloaded). The app runs ffprobe + keyframe analysis and reports the real current target:
   resolution, bitrate, profile, fps, GOP, audio spec.
2. The app **diffs** that against the stored defaults and offers to update the active preset
   (writing new values to the JSON config). This is the empirical calibration loop.
3. How to obtain a WhatsApp-processed file: post to Status → save your own status, or on Android
   pull from `Android/media/com.whatsapp/WhatsApp/Media/.Statuses`.

This turns "trust a hardcoded guess" into "measure, then match" — the only honest way to keep
quality optimal over time.

### 6.1 Reference-app matching (open task)

The v2 recipe was tuned to beat a reference app but not yet verified in a final side-by-side. If
output still trails it: obtain a reference-app output clip (its export, *before* posting to
WhatsApp), run it through Probe mode, read its exact resolution/bitrate/fps/profile, and align
the v2 defaults to match-or-exceed those numbers. Measure the competitor's intermediate; don't
theorize.

---

## 7. Validation / acceptance

1. Drop a 1080p60 clip → produces a 1080-short-edge, source-fps, ~6 Mbps H.264 High mp4 with
   faststart and **no** dropped-frame judder (verify `drop=0`, or proper fps-filter selection if
   an fps cap is active).
2. Probe mode on a WhatsApp-processed clip reproduces the §2 table.
3. End-to-end: conform → post to Status → re-download → re-probe. Compare against posting the raw
   original. The conformed path should retain visibly more detail — the real success metric.
4. Splitter produces clean ≤30s segments that each play and conform correctly.

> Note: an early draft of the acceptance list described v1 numbers (720/30fps/1.8 Mbps). The
> authoritative target is the v2 recipe above (1080 / source-fps / ~6 Mbps). If you see 720/1.8M
> referenced anywhere, it's stale.

---

## 8. Out of scope

- No cloud upload / third-party servers. Everything local — privacy is a feature.
- No opaque binary distribution — the Tauri app is the deliverable.
- No unrelated platform features. This tool does one thing: WhatsApp Status conform.

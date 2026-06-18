<h1 align="center">PureSignal</h1>

<p align="center">
  <b>WhatsApp Status video quality optimizer.</b><br>
  Stop your Status uploads from turning to mush.
</p>

<p align="center">
  <i>by <b>dr.v0id</b> (TK NiRMAL)</i>
</p>

---

## Why this exists

WhatsApp re-encodes **every** video you post to Status, unconditionally, down to a
small low-bitrate target so it can deliver globally over weak connections. The "blur"
everyone complains about isn't malice — it's the damage from a single, fast, low-effort
encoder making one violent jump (e.g. `1080p60 @ 17 Mbps → ~464x832 @ 630 kbps`).

You can't turn that re-encode off. But you **can** decide where the lossy step happens
and how good it is. PureSignal inserts a high-effort, locally-controlled encode *before*
WhatsApp's pass: it pre-conforms your clip to a detail-rich intermediate (full 1080
short-edge, ~6 Mbps, slow high-profile x264, original framerate preserved). When WhatsApp
then re-encodes, it either near-passes-through or makes only a small jump — and because the
intermediate was encoded carefully, far more detail survives.

**Two gentle compressions beat one violent one.** That's the whole idea. No metadata
tricks, no servers, no accounts — everything runs locally on your machine.

## Features

- **Drag & drop** one or many clips, processed as a queue with live per-file progress.
- **Source inspection** on drop — resolution, fps, codec, bitrate, duration (via ffprobe).
- **The v2 recipe** baked in: keep source fps (no judder), 1080 short-edge, ~6 Mbps
  high-profile x264 — tuned to feed WhatsApp a detail-rich source.
- **30-second splitter** — clips over WhatsApp's 30s Status limit are cut at keyframe
  boundaries into independently-conformed segments.
- **Advanced panel** — override target bitrate, resolution cap, fps mode, and the splitter.
- **Probe / Recalibration mode** — WhatsApp's target spec drifts across app versions. Drop a
  clip that has *already been through* WhatsApp Status and PureSignal measures the current
  real target, diffs it against your preset, and offers to update it. Measure, then match.
- **Bundled ffmpeg** — a setup script fetches platform ffmpeg/ffprobe locally; no system
  install required.

## Requirements

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/) (`corepack enable` gives you pnpm)
- [Rust](https://rustup.rs/) (stable) + the platform C/C++ toolchain Tauri needs:
  - **Windows:** "Desktop development with C++" (MSVC build tools) + WebView2 (ships with Win 11)
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `webkit2gtk`, `libappindicator`, `librsvg` (see Tauri's prerequisites)

## Quick start

```bash
git clone <your-repo-url> PureSignal
cd PureSignal

pnpm install          # JS dependencies
pnpm setup            # generate app icons + fetch ffmpeg/ffprobe for this platform

pnpm tauri dev        # run in development
pnpm tauri build      # produce a distributable installer
```

`pnpm setup` is `gen:icons` + `fetch:ffmpeg`. You can run them individually:

```bash
pnpm gen:icons        # (re)generate the icon set
pnpm fetch:ffmpeg     # download ffmpeg + ffprobe into src-tauri/binaries/
```

The ffmpeg binaries are **not** committed (they're large and platform-specific) — the
fetch script repopulates them on any fresh clone, so the repo stays lean.

## How to recalibrate (keep it accurate over time)

WhatsApp's Status target is not a constant; it changes with app versions and differs between
iOS and Android. To re-measure it:

1. Post any clip to your WhatsApp Status, then **re-download your own status**.
   - On Android you can also pull it from
     `Android/media/com.whatsapp/WhatsApp/Media/.Statuses`.
2. In PureSignal, switch to **Probe** mode and drop that WhatsApp-processed file.
3. PureSignal reports the real current target (resolution, bitrate, profile, fps, GOP, audio)
   and diffs it against your stored preset. Apply the diff to update your defaults.

This turns "trust a hardcoded guess" into "measure, then match" — the only honest way to keep
quality optimal as WhatsApp changes.

## The encoding rationale (why each knob is set the way it is)

This recipe went through one real-world revision (v1 → v2) after side-by-side testing. The
short version of what v2 fixes:

- **Keep source framerate.** v1 used ffmpeg `-r 30`, which naively *drops* frames (judder).
  v2 preserves the source fps — smooth motion is half the perceived-quality gap. If a future
  probe shows WhatsApp hard-caps fps, the fps filter (proper frame selection) is used, never `-r`.
- **Feed it big, not small.** v1 pre-scaled to 720 short-edge at 1800 kbps, handing WhatsApp a
  bit-starved source → visibly soft. v2 feeds full 1080 short-edge at ~6 Mbps so far more detail
  enters WhatsApp's pipeline and survives its final crush. The intermediate is *meant* to be
  re-crushed; the goal is to hand WhatsApp clean, detailed pixels.
- **High profile, B-frames, `aq-mode=3`.** The opposite of WhatsApp's weak Baseline/0-B-frame
  encode — more efficient, more detail per bit, bits steered toward complex regions.
- **`preset slow`, not `veryslow`.** At ~6 Mbps, veryslow buys almost nothing visible and just
  wastes minutes. Detail comes from bits, not from a slower preset.
- **`keyint=30` + `+faststart`.** ~1s GOP to align with WhatsApp's re-encode; moov atom up front
  for a clean parse.

Full design notes, parameter-by-parameter, live in [`DESIGN.md`](DESIGN.md).

## Privacy

Everything is local. No cloud upload, no third-party servers, no telemetry. Your clips never
leave your machine.

## License

[MIT](LICENSE) © 2026 dr.v0id (TK NiRMAL)

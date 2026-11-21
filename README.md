# Quiver

A single-file, zero-dependency, 100% offline HTML5 VSRG (vertical scrolling rhythm game) modeled for near singleplayer feature parity with **Quaver**.

Open [quaver-browser.html](quaver-browser.html) directly in any modern browser (`file://`, local server, or embedded webview) — no build step, no external libraries, and no internet connection required.

## Highlights

- **Single-File & 100% Offline**: Pure vanilla HTML/CSS/JS + Canvas2D + Web Audio API with an embedded pure-JS RFC 1951 Inflate fallback for `.qp`/`.zip` unpacking.
- **Low-Latency Engine**:
  - Hardware-aligned Web Audio timing (`AudioContext({ latencyHint: 'interactive' })` + `getOutputTimestamp()`).
  - Event-driven sub-millisecond keyboard (`e.code` + `e.timeStamp`) and touch/pointer input decoupled from `requestAnimationFrame`.
  - Built-in 120 BPM interactive audio offset calibration wizard + live per-map local offsets (`-`/`+`/`0`).
- **Singleplayer Quaver Parity**:
  - Supports **1K–10K** (4K & 7K presets out of the box), Long Notes (dual head/tail judgements, `1.5×` release window, late hold-over auto-Good), Mines, negative/reverse Scroll Velocities (SV), `ScrollSpeedFactors` (SSF), and `TimingGroups`.
  - Exact judgement presets (`Standard`, `Lenient`, `Chill`, `Strict`, `Tough`, `Extreme`), accuracy weights, 1,000,000 scoring, HP drain/gain, grades (`X`–`F`), and Performance Rating (`PR`).
  - Mods: Rate (`0.50x`–`2.00x`, pitched & unpitched), Mirror, Randomize, No LN, Full LN, Inverse, No SV, No Fail, No Miss, Autoplay, plus Practice Mode (scrubbing & A–B loops) and local Replay recording/playback.
  - Full-viewport Results recap with 5 swappable interactive analytics graphs (`Accuracy`, `Hit Error`, `Distribution`, `Health`, and `Combo & NPS`).
- **Separate Song Packaging**:
  - Built-in procedural Web Audio starter mapset (**Darkwave Pulse**, 4K & 7K) playable immediately.
  - Import native `.qp` / `.zip` / `.osz` archives, unpacked Quaver `Songs/` folders, loose `.qua` / `.osu` (Mania Mode 3) charts, or hyper-compact **`.qpack`** library packs (lazy `File.slice()` streaming, opens hundreds of charts in ~50 ms).
  - Supports optional custom Quaver skin folders at runtime.

## Quick Start

1. Download or clone this repository.
2. Open `quaver-browser.html` in your browser (Chrome, Edge, Firefox, Safari, or an integrated webview).
3. Drag and drop `.qpack`, `.qp`, `.osz`, `.qua`, or unpacked song folders directly onto the window.

> **Tip (Fullscreen `Escape` Lock)**: Serving locally (e.g., `npx serve .` or `python -m http.server`) enables Chromium's Keyboard Lock API so `Escape` pauses in-game instead of leaving fullscreen — and automatically discovers any adjacent `.qpack` file in the same folder. On `file://`, native `F11` fullscreen also keeps `Escape` in-game.

## Packaging a Steam Quaver Library (`.qpack`)

Use the zero-dependency Node.js packager (`package-library.js`) to pack an entire local `Quaver/Songs/` directory into a single instant-load `.qpack` file (pulls exact official difficulty ratings across all 31 rates from `quaver.db` when present, and optionally compacts backgrounds/audio with `ffmpeg`):

```bash
# Default: lossless audio copy (0ms drift) + 1280px JPEG backgrounds
node package-library.js

# Ultra-compact Vorbis audio (~120 MB for ~100 mapsets)
node package-library.js --audio ogg --bitrate 96k

# Custom songs directory & output path
node package-library.js --songs "C:\Program Files (x86)\Steam\steamapps\common\Quaver\Songs" --out "./quiver-library.qpack"
```

Run `node package-library.js --help` for all options (`--mode 4k|7k`, `--bg-width`, `--no-bg`, `--no-sfx`).

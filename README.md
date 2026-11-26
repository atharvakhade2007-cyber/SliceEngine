# SliceEngine

**SliceEngine** is a local web application that turns pasted video links into vertical 9:16 captioned clips. It uses `yt-dlp` + `ffmpeg` to download, analyze, and render clips with facecam overlays, auto-generated captions, and platform-aware clipping.

## Quick Start

### On Windows

```powershell
# 1. Install dependencies (ffmpeg includes ffprobe)
winget install Gyan.FFmpeg   # or download ffmpeg from https://ffmpeg.org/download.html and add to PATH
pip install yt-dlp

# 2. Start the engine
python engine.py

# 3. Open your browser
#    http://127.0.0.1:4173
```

### On macOS

```bash
# 1. Install ffmpeg and yt-dlp
brew install ffmpeg
pip install yt-dlp

# 2. Start the engine
python engine.py

# 3. Open your browser
#    http://127.0.0.1:4173
```

### On Linux

```bash
# 1. Install ffmpeg and yt-dlp
sudo apt-get update && sudo apt-get install -y ffmpeg
pip3 install yt-dlp

# 2. Start the engine
python3 engine.py

# 3. Open your browser
#    http://127.0.0.1:4173
```

## How It Works

SliceEngine runs 100% locally on your machine (no cloud servers or external AI/LLM APIs required):

1. **Web UI (`index.html`, `styles.css`, `app.js`)**: Serves the Studio, Live, and Library tabs, interactive facecam box editor, and clip previews in your browser.
2. **Local Engine (`engine.py`)**: A lightweight Python HTTP server on `http://127.0.0.1:4173` that orchestrates `yt-dlp` and `ffmpeg`:
   - **Highlight scoring**: Extracts the audio track and scores loudness peaks (`ffmpeg` RMS energy) to suggest clip timestamps—no LLM needed.
   - **Facecam detection**: Samples pairs of grayscale frames and compares motion across corners to guess where your webcam is placed.
   - **Approval & 9:16 rendering**: Pauses for you to confirm or adjust the facecam box and layout (`auto`, `gameplay`, `split`, `facecam`, `full`), then crops and encodes `1080x1920` MP4 clips into `clips/`.
   - **Live mode**: Connects to live stream edges via `yt-dlp` + `ffmpeg`, takes periodic frames, buffers requested moments, and renders clips after you approve them.

## Features

- **Studio mode**: Paste a YouTube/Twitch/Kick URL, select caption length and layout, review facecam box, get auto-captured clips
- **Live mode**: Watch live streams, capture clips on-the-fly with per-clip approval gate
- **Facecam detection**: Heuristic corner-detection to guess webcam box position
- **Auto-captions**: SRT parsing and burn-in or sidecar subtitle files
- **Platform-aware clipping**: Different max lengths for TikTok (180s), Reels (90s), Shorts (60s)
- **Cache management**: Clear storage, single-file delete for `clips/` and `uploads/`
- **Notification system**: Bell/toast system replaces legacy `toast()` calls
- **Two-phase job pipeline**: Phase 1 downloads + scores + facecam guess (awaits approval), Phase 2 renders approved clips

## UI Overview

| Tab | Description |
|-----|-------------|
| **Studio** | Process past videos with full analysis and clipping |
| **Live** | Watch live streams, capture moment clips |
| **Library** | View previously clipped videos |
| **Storage** | View and manage cached/temporary files |

### Studio Workflow

1. Paste a video URL (YouTube, Twitch, Kick) or upload a file
2. Engine analyzes duration, audio curve, and suggests clip moments
3. Review facecam screenshots — guess the webcam box position
4. Approve layout (facecam/gameplay/split/full)
5. Clips are rendered with captions and exported to `clips/`

### Live Workflow

1. Paste a live stream URL
2. Watch the stream with periodic facecam screenshots
3. When something interesting happens, click "Capture Clip"
4. Clip records the live edge immediately
5. You approve/reject the clip before rendering
6. Rendered clips appear in `clips/live-<id>/`

## Configuration

Settings are stored in `localStorage` in the browser (key: `neonclip.settings.v1`). You can reset by clearing browser storage.

Default settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `captions` | `true` | Whether to attempt caption fetching |
| `captionMode` | `burn` | 'burn' burns captions into video, 'sidecar' outputs separate SRT |
| `minLen` | `30` | Minimum clip length in seconds |
| `maxLen` | `80` | Maximum clip length in seconds |
| `count` | `3` | Number of suggested clip moments |
| `preset` | `reels` | Platform preset: reels/tiktok/shorts/custom |
| `layout` | `auto` | Automatic layout selection (facecam/gameplay/split/full) |
| `facecam` | `{x:0.03, y:0.62, w:0.28, h:0.32}` | Manual facecam box coordinates |

## Requirements

### System

- **ffmpeg** — must be on `PATH` (GPL build recommended)
- **ffprobe** — comes with ffmpeg
- **yt-dlp** — Python package for video extraction

### Python Packages

Create a `requirements.txt` with:

```
ffmpeg-python>=0.2.0  # optional: Python wrapper for ffmpeg
yt-dlp>=2024.2.0      # video extraction
```

**Note**: The engine itself only requires `ffmpeg`, `ffprobe`, and `yt-dlp` on the system PATH. The `requirements.txt` above is optional for Python-side dependencies.

## Project Structure

```
.
├── engine.py          # Backend engine (HTTP server, ffmpeg orchestration, live sessions)
├── app.js           # Frontend UI, notifications, storage panel, live wiring
├── index.html       # HTML structure and UI
├── styles.css       # CSS styling (notifications, live panels, storage)
├── clips/           # Rendered MP4 clips output directory
├── uploads/         # User-uploaded files directory
├── .cache/          # Temporary download/cache directory
├── requirements.txt # Python packages (optional)
└── README.md        # This file
```

## Development / Running From Source

```bash
# 1. Clone / ensure you have the files
git clone https://github.com/atharvakhade2007-cyber/SliceEngine
cd SliceEngine

# 2. Install system deps
#   - ffmpeg + ffprobe on PATH
#   - yt-dlp: pip install yt-dlp

# 3. Start the engine
python engine.py

# 4. Open http://127.0.0.1:4173 in your browser
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `ffmpeg not found` | Install ffmpeg and ensure it's on PATH |
| `yt-dlp not found` | `pip install yt-dlp` or install via OS package manager |
| Live stream "no playable format" | Try a different URL format, or use the stream URL directly (m3u8/mpd) |
| Clips have no audio | Some live streams video-only; the engine pulls a separate audio rendition if available |
| "could not read a frame" | Video may have DRM or the URL may have expired |
| Storage panel shows large .cache | Use the "Clear storage" button; this deletes temp files inside `.cache/` |

## Known Issues

- **Captions**: Caption fetching currently relies on `yt-dlp` downloading existing or auto-generated English (`en.*,en`) subtitles from the source URL. If a video, ended stream, local file, or live stream does not have available subtitles (or uses another language), captions will be skipped. Custom caption styles (`GTA`, `Hormozi`, `MrBeast`, etc.) also do not yet map to `ffmpeg` burn-in styling. There is a known issue with captions that will be fixed in later versions (e.g. with local speech-to-text / Whisper fallback and full style support).

## License

This project is free to use, modify, and distribute. No license restrictions.
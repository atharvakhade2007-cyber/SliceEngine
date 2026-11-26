#!/usr/bin/env python3
"""SliceEngine local engine.

Serves the static UI and cuts real MP4s with yt-dlp + ffmpeg.

    python engine.py              # http://127.0.0.1:4173
    python engine.py --port 4180
    python engine.py --selftest   # exercises audio scoring + crop without a network

Endpoints
    GET  /api/health              tool availability
    GET  /api/analyze?url=...     title, duration, thumbnail (cached locally)
    POST /api/upload?name=...     raw body -> {"upload": "uploads/<file>"}
    POST /api/clips               start a job, returns {"id": ...}
    GET  /api/jobs/<id>           stage, percent, review frames, clips
    POST /api/jobs/<id>/approve   approve the facecam layout, clipping starts
    POST /api/jobs/<id>/cancel    stop the job and kill its downloader/renderer
    GET  /api/shot/<job>/<name>   review screenshots

A job runs in two phases. Phase one reads the link, downloads the audio, scores
the loud moments and grabs a few frames with a guess at the facecam box; it then
waits for approval. Phase two cuts the clips with the approved layout.
"""

from __future__ import annotations

import argparse
import array
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
CLIPS_DIR = ROOT / "clips"
UPLOAD_DIR = ROOT / "uploads"
CACHE_DIR = ROOT / ".cache"
for _d in (CLIPS_DIR, UPLOAD_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or ""
FFPROBE = shutil.which("ffprobe") or ""
YTDLP = shutil.which("yt-dlp") or ""
VERSION = "1.0"

JOBS: dict[str, dict] = {}
LIVE: dict[str, dict] = {}
PROCS: dict[str, subprocess.Popen] = {}
JOBS_LOCK = threading.Lock()
LIVE_LOCK = threading.Lock()
LIVE_SAMPLE_SECONDS = 15


class Cancelled(Exception):
    """The user pressed stop."""


# ───────────────────────────── process helpers ─────────────────────────────
def run(cmd, cwd=None, timeout=None, job=None):
    """Run a tool. With a job, the child is registered so /cancel can kill it."""
    cwd_str = str(cwd) if cwd else None
    if job is None:
        try:
            p = subprocess.run(
                cmd, cwd=cwd_str, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout,
            )
            return p.returncode, p.stdout or "", p.stderr or ""
        except subprocess.TimeoutExpired:
            return 124, "", "timed out"
        except FileNotFoundError as exc:
            return 127, "", str(exc)

    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd_str, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)

    with JOBS_LOCK:
        PROCS[job["id"]] = proc
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        return 124, out or "", (err or "") + " timed out"
    except Exception as exc:  # noqa: BLE001 - a killed child can raise here
        return 1, "", str(exc)
    finally:
        with JOBS_LOCK:
            if PROCS.get(job["id"]) is proc:
                PROCS.pop(job["id"], None)
    return proc.returncode, out or "", err or ""


def cancel_job(job: dict) -> None:
    """Stop a job wherever it is: downloading, waiting for approval or rendering."""
    with JOBS_LOCK:
        job["cancelled"] = True
        proc = PROCS.get(job.get("id", ""))
        gate = job.get("gate")
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass
    if gate is not None:
        gate.set()


def tail(text: str, lines: int = 4) -> str:
    clean = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return " ".join(clean[-lines:])


def fmt_time(sec: float) -> str:
    sec = max(0.0, float(sec))
    return f"{int(sec // 3600):02d}:{int((sec % 3600) // 60):02d}:{int(sec % 60):02d}"


_SUB_FILTER: bool | None = None


def has_subtitle_filter() -> bool:
    global _SUB_FILTER
    if _SUB_FILTER is None:
        _SUB_FILTER = False
        if FFMPEG:
            code, out, err = run([FFMPEG, "-hide_banner", "-filters"], timeout=60)
            _SUB_FILTER = bool(re.search(r"\bsubtitles\b", (out or "") + (err or "")))
    return _SUB_FILTER


def probe_duration(path: Path) -> float:
    if not FFPROBE:
        return 0.0
    code, out, _ = run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        timeout=120,
    )
    try:
        return float(json.loads(out)["format"]["duration"])
    except Exception:
        return 0.0


def probe_size(path: Path) -> str:
    if not FFPROBE:
        return ""
    code, out, _ = run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "json", str(path)],
        timeout=120,
    )
    try:
        stream = json.loads(out)["streams"][0]
        return f'{stream["width"]}x{stream["height"]}'
    except Exception:
        return ""


# ───────────────────────────── facecam detection ─────────────────────────────
SHOT_W, SHOT_H = 160, 90
SHOT_JPEG_W = 768
DEFAULT_REGION = {"x": 0.03, "y": 0.62, "w": 0.28, "h": 0.32}
CANDIDATE_SIZES = ((0.26, 0.32), (0.32, 0.40), (0.22, 0.26), (0.34, 0.46))


def clean_region(region) -> dict:
    try:
        x = max(0.0, min(0.95, float(region.get("x", DEFAULT_REGION["x"]))))
        y = max(0.0, min(0.95, float(region.get("y", DEFAULT_REGION["y"]))))
        w = max(0.05, min(1.0 - x, float(region.get("w", DEFAULT_REGION["w"]))))
        h = max(0.05, min(1.0 - y, float(region.get("h", DEFAULT_REGION["h"]))))
        return {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}
    except (TypeError, ValueError, AttributeError):
        return dict(DEFAULT_REGION)


def candidate_boxes() -> list[dict]:
    boxes = []
    for w, h in CANDIDATE_SIZES:
        for corner in ("tl", "tr", "bl", "br"):
            x = 0.02 if corner[1] == "l" else 1.0 - w - 0.02
            y = 0.02 if corner[0] == "t" else 1.0 - h - 0.02
            boxes.append({"x": round(x, 4), "y": round(y, 4), "w": w, "h": h})
    return boxes


def motion_map(a: bytes, b: bytes) -> list[int]:
    return [1 if abs(x - y) > 16 else 0 for x, y in zip(a, b)]


def box_motion(mask, box) -> float:
    x0 = int(box["x"] * SHOT_W)
    x1 = max(x0 + 1, int((box["x"] + box["w"]) * SHOT_W))
    y0 = int(box["y"] * SHOT_H)
    y1 = max(y0 + 1, int((box["y"] + box["h"]) * SHOT_H))
    total = 0
    moving = 0
    for y in range(y0, min(SHOT_H, y1)):
        row = y * SHOT_W
        for x in range(x0, min(SHOT_W, x1)):
            total += 1
            moving += mask[row + x]
    return moving / total if total else 1.0


def iou(a: dict, b: dict) -> float:
    ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def detect_facecam(pairs) -> dict | None:
    """Guess the webcam box: the corner rectangle that changes least between close frames.

    A webcam keeps its room in the background while the game frame underneath moves
    everywhere, so the calmest corner box is usually the camera. It is only a guess —
    the review screenshots are there so a person can correct it.
    """
    masks = [motion_map(a, b) for a, b in pairs if a and b]
    if not masks:
        return None
    scored = []
    for box in candidate_boxes():
        motion = sum(box_motion(mask, box) for mask in masks) / len(masks)
        scored.append((1.0 - motion, motion, box))
    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, _, best = scored[0]
    rivals = [item[0] for item in scored[1:] if iou(item[2], best) < 0.35]
    rival = rivals[0] if rivals else 0.0
    confidence = max(0.0, min(0.95, 0.15 + (best_score - rival) * 2.4 + max(0.0, best_score - 0.45) * 0.6))
    return {"facecam": dict(best), "confidence": round(confidence, 2),
            "staticShare": round(best_score, 3)}


def shot_times(duration: float, windows) -> list[float]:
    """Spread a handful of screenshots over the whole video, plus each planned clip."""
    duration = float(duration or 0)
    if duration < 4:
        return [max(0.2, duration / 2)]
    count = 6 if duration > 900 else 4
    times = [duration * (i + 0.5) / count for i in range(count)]
    for window in windows or []:
        times.append(min(duration - 1.0, float(window.get("start") or 0) + 0.6))
    keep: list[float] = []
    for at in sorted(times):
        if at < 0.4 or at > duration - 0.4:
            continue
        if keep and at - keep[-1] < 3.0:
            continue
        keep.append(round(at, 1))
    return keep[:8]


def region_for(start: float, shots, fallback: dict) -> dict:
    """The approved facecam box nearest to a clip start."""
    best = None
    best_gap = None
    for shot in shots or []:
        try:
            gap = abs(float(shot.get("at") or 0) - float(start))
        except (TypeError, ValueError):
            continue
        if best_gap is None or gap < best_gap:
            best_gap, best = gap, shot
    if best and isinstance(best.get("facecam"), dict):
        return clean_region(best["facecam"])
    return clean_region(fallback or {})


def grab_args(preview) -> list[str]:
    args: list[str] = []
    headers = (preview or {}).get("headers") or {}
    ua = headers.get("User-Agent")
    if ua:
        args += ["-user_agent", str(ua)]
    extra = "".join(f"{k}: {v}\r\n" for k, v in headers.items() if str(k).lower() != "user-agent")
    if extra:
        args += ["-headers", extra]
    return args


class Frames:
    """One frame (and a motion pair) at any timestamp, from a file or a link."""

    def __init__(self, src_path, url, work: Path, job: dict, preview=None):
        self.path = src_path
        self.url = url or ""
        self.work = work / "shots"
        self.work.mkdir(parents=True, exist_ok=True)
        self.job = job
        self.preview = preview if (preview and preview.get("url")) else None
        self.http_ok = bool(self.preview)
        self.sections: list[tuple[float, float, Path]] = []
        self.parts = 0

    def _source_at(self, at: float):
        if self.path is not None:
            return str(self.path), float(at), []
        if self.http_ok and self.preview:
            return str(self.preview.get("url")), float(at), grab_args(self.preview)
        for start, end, path in reversed(self.sections):
            if start <= at <= end:
                return str(path), float(at - start), []
        return self._section(at)

    def _section(self, at: float):
        """Remote fallback: download ~4 seconds around the timestamp with yt-dlp."""
        if not (YTDLP and self.url):
            return None
        start = max(0.0, at - 1.0)
        end = at + 3.0
        self.parts += 1
        tpl = str(self.work / f"near{self.parts}.%(ext)s")
        run([YTDLP, "--no-playlist", "--no-warnings", "-f",
             "bv*[height<=720]/b[height<=720]/b",
             "--download-sections", f"*{fmt_time(start)}-{fmt_time(end)}",
             "-o", tpl, self.url], job=self.job, timeout=900)
        for path in sorted(self.work.glob(f"near{self.parts}.*")):
            if path.suffix.lower() in (".part", ".ytdl") or path.stat().st_size < 2048:
                continue
            self.sections.append((start, end + 1.0, path))
            return str(path), float(at - start), []
        return None

    def _gray(self, src: str, offset: float, headers, tag: str):
        out = self.work / f"{tag}.gray"
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + list(headers)
        if offset > 0.01:
            cmd += ["-ss", f"{offset:.3f}"]
        cmd += ["-i", src, "-frames:v", "1", "-vf", f"scale={SHOT_W}:{SHOT_H}",
                "-pix_fmt", "gray", "-f", "rawvideo", str(out)]
        code, _, _ = run(cmd, job=self.job, timeout=240)
        if code != 0 or not out.exists():
            return None
        data = out.read_bytes()
        return data[:SHOT_W * SHOT_H] if len(data) >= SHOT_W * SHOT_H else None

    def _jpeg(self, src: str, offset: float, headers, tag: str):
        out = self.work / f"{tag}.jpg"
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + list(headers)
        if offset > 0.01:
            cmd += ["-ss", f"{offset:.3f}"]
        cmd += ["-i", src, "-frames:v", "1", "-vf", f"scale={SHOT_JPEG_W}:-2",
                "-q:v", "4", str(out)]
        code, _, _ = run(cmd, job=self.job, timeout=240)
        return out if code == 0 and out.exists() and out.stat().st_size > 1024 else None

    def frame(self, at: float, tag: str):
        for attempt in (0, 1):
            found = self._source_at(at)
            if not found:
                return None, None
            src, offset, headers = found
            gray = self._gray(src, offset, headers, tag)
            if gray is None:
                if attempt == 0 and self.http_ok:
                    self.http_ok = False
                    continue
                return None, None
            return gray, self._jpeg(src, offset, headers, tag)
        return None, None

    def shot(self, at: float, index: int):
        first, jpeg = self.frame(at, f"shot{index}a")
        if first is None:
            return None
        second, _ = self.frame(at + 0.7, f"shot{index}b")
        return {"at": round(float(at), 1), "pair": (first, second or first),
                "image": jpeg.name if jpeg else ""}


# ───────────────────────────── metadata / captions ─────────────────────────────
def analyze(url: str, want_preview: bool = False) -> dict:
    if not YTDLP:
        raise RuntimeError("yt-dlp is not installed")
    code, out, err = run([YTDLP, "-J", "--no-playlist", "--no-warnings", url], timeout=180)
    if code != 0 or not (out or "").strip():
        raise RuntimeError(tail(err) or "yt-dlp could not read that link")
    try:
        info = json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError("yt-dlp returned unreadable metadata")

    thumb_url = info.get("thumbnail") or ""
    thumb_path = ""
    if thumb_url:
        name = f"{info.get('id') or uuid.uuid4().hex}.jpg"
        dest = CACHE_DIR / name
        if not dest.exists():
            try:
                import urllib.request

                req = urllib.request.Request(thumb_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=12) as res:
                    dest.write_bytes(res.read())
            except Exception:
                dest = None  # type: ignore[assignment]
        if dest is not None and dest.exists() and dest.stat().st_size > 1024:
            thumb_path = f"/api/thumb/{name}"

    preview = None
    if want_preview:
        def playable(fmt) -> bool:
            # Live edges come back as m3u8 (protocol "m3u8_native"), not plain http.
            proto = str(fmt.get("protocol") or "https")
            return (bool(fmt.get("url"))
                    and str(fmt.get("vcodec") or "none") != "none"
                    and (proto.startswith("http") or proto.startswith("m3u8")))

        formats = [f for f in (info.get("formats") or []) if playable(f)]
        if info.get("is_live") is True:
            # Recording a live edge wants HLS, muxed if the platform offers it,
            # at a sane quality for the crop.
            formats.sort(key=lambda f: (
                0 if str(f.get("protocol") or "").startswith("m3u8") else 1,
                0 if str(f.get("acodec") or "none") != "none" else 1,
                abs((f.get("height") or 0) - 720),
            ))
        else:
            formats.sort(key=lambda f: abs((f.get("height") or 0) - 480))
        if formats:
            best = formats[0]
            preview = {"url": best["url"], "headers": info.get("http_headers") or {}}
            if info.get("is_live") is True and str(best.get("acodec") or "none") == "none":
                # Video-only live edge (YouTube sends no audio in these renditions),
                # so the audio comes from its own rendition.
                audio = [f for f in (info.get("formats") or [])
                         if f.get("url") and str(f.get("vcodec") or "none") == "none"
                         and str(f.get("protocol") or "").startswith("m3u8")]
                audio.sort(key=lambda f: -float(f.get("abr") or f.get("tbr") or 0))
                if audio:
                    preview["audio"] = audio[0]["url"]
        elif info.get("url"):
            preview = {"url": info["url"], "headers": info.get("http_headers") or {}}

    return {
        "_preview": preview,
        "title": info.get("title") or "Video",
        "duration": float(info.get("duration") or 0),
        "uploader": info.get("uploader") or "",
        "id": info.get("id") or "",
        "thumbnail": thumb_path,
        "isLive": info.get("is_live") is True,
        "webpage": info.get("webpage_url") or url,
    }


def fetch_subs(url: str, work: Path) -> Path | None:
    if not YTDLP:
        return None
    run(
        [YTDLP, "--skip-download", "--no-playlist", "--no-warnings",
         "--write-auto-subs", "--write-subs", "--sub-langs", "en.*,en",
         "--convert-subs", "srt", "-o", str(work / "src.%(ext)s"), url],
        timeout=300,
    )
    subs = sorted(work.glob("*.srt"))
    return subs[0] if subs else None


SRT_BLOCK = re.compile(
    r"(\d+)\s*\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\s*\n(.*?)(?=\n\s*\n|\Z)",
    re.S,
)


def parse_ts(stamp: str) -> float:
    h, m, rest = stamp.split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def make_ts(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms >= 1000:
        s, ms = s + 1, 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def slice_srt(text: str, start: float, end: float) -> str:
    """Cut a subtitle file down to one clip window, rebased to 0."""
    rows = []
    for match in SRT_BLOCK.finditer((text or "").replace("\r\n", "\n")):
        a, b = parse_ts(match.group(2)), parse_ts(match.group(3))
        if b <= start or a >= end:
            continue
        body = " ".join(part.strip() for part in match.group(4).split("\n") if part.strip())
        body = re.sub(r"<[^>]+>", "", body).strip()
        if not body:
            continue
        rows.append((max(a, start) - start, min(b, end) - start, body))

    # YouTube auto-captions repeat rolling lines; keep the first of each.
    deduped = []
    for row in rows:
        if deduped and deduped[-1][2] == row[2]:
            continue
        deduped.append(row)

    blocks = []
    for i, (a, b, body) in enumerate(deduped):
        if b - a < 0.2:
            b = a + 0.2
        blocks.append(f"{i + 1}\n{make_ts(a)} --> {make_ts(b)}\n{body}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


# ───────────────────────────── audio analysis ─────────────────────────────
def audio_curve(src: Path, work: Path) -> list[float]:
    """RMS loudness per second, 8 kHz mono. Empty list when it cannot be read."""
    wav = work / "audio.wav"
    code, _, _ = run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "8000", "-f", "wav", str(wav)],
        timeout=7200,
    )
    if code != 0 or not wav.exists():
        return []
    try:
        with wave.open(str(wav), "rb") as handle:
            rate = handle.getframerate() or 8000
            raw = handle.readframes(handle.getnframes())
    except Exception:
        return []

    samples = array.array("h")
    try:
        samples.frombytes(raw)
    except ValueError:
        return []

    step = max(1, rate)
    curve = []
    for i in range(0, max(0, len(samples) - step + 1), step):
        chunk = samples[i:i + step]
        acc = 0.0
        n = 0
        for j in range(0, len(chunk), 16):
            v = chunk[j]
            acc += v * v
            n += 1
        curve.append((acc / max(1, n)) ** 0.5)
    return curve


def plan_windows(curve, duration, count, min_len, max_len) -> list[dict]:
    count = max(1, min(int(count or 3), 5))
    min_len = max(8, int(min_len or 30))
    max_len = max(min_len + 2, int(max_len or 80))
    duration = float(duration or 0)

    if duration <= min_len + 2:
        length = max(3.0, duration - 0.4)
        return [{"start": 0.0, "end": length, "score": 80}]

    length = int(min(max_len, max(min_len, round((min_len + max_len) / 2))))
    length = min(length, max(4, int(duration) - 2))

    picks: list[tuple[float, int]] = []
    if len(curve) > length + 4:
        step = max(2, length // 3)
        scored = []
        for start in range(2, len(curve) - length - 1, step):
            seg = curve[start:start + length]
            mean = sum(seg) / len(seg)
            var = sum((v - mean) ** 2 for v in seg) / len(seg)
            peak = max(seg)
            scored.append((mean + 0.55 * (peak - mean) + 0.35 * (var ** 0.5), start))
        scored.sort(reverse=True)
        picks = scored

    windows: list[dict] = []
    for score, start in picks:
        if all(abs(start - w["start"]) >= length + 6 for w in windows):
            windows.append({"start": float(start), "end": float(start + length), "score": score})
        if len(windows) >= count:
            break

    span = max(1.0, duration - length - 4)
    latest = max(0.0, duration - length - 0.5)
    for slot in range(count * 3):
        if len(windows) >= count:
            break
        start = min(latest, 2.0 + span * ((slot + 0.5) / count))
        # never stack clips on top of each other on short videos
        if any(abs(start - w["start"]) < length * 0.9 for w in windows):
            continue
        if any(abs(start - w["start"]) < 1.0 for w in windows):
            continue
        windows.append({"start": round(start, 1), "end": round(start + length, 1), "score": 0.0})

    if len(windows) < count:
        # Short video: spread the requested number evenly, shortening if it must.
        def spread(span_len: int) -> list[dict]:
            room = max(0.0, duration - 4 - span_len)
            return [{"start": round(2.0 + room * (i / max(1, count - 1)), 1),
                     "end": round(2.0 + room * (i / max(1, count - 1)) + span_len, 1),
                     "score": 0.0} for i in range(count)]

        rebuilt = spread(length)
        if count * length > duration - 4:
            length = max(5, int((duration - 4) / count))
            rebuilt = spread(length)
        if len(rebuilt) == count and rebuilt[-1]["end"] <= duration:
            windows = rebuilt

    windows.sort(key=lambda w: w["start"])
    top = max([w["score"] for w in windows] + [1.0])
    for w in windows:
        w["score"] = round(min(97.0, 78.0 + 19.0 * (w["score"] / top))) if top else 82
    return windows


# ───────────────────────────── ffmpeg rendering ─────────────────────────────
def crop_expr(region: dict) -> str:
    x = max(0.0, min(0.95, float(region.get("x", 0.03))))
    y = max(0.0, min(0.95, float(region.get("y", 0.62))))
    w = max(0.05, min(1.0 - x, float(region.get("w", 0.28))))
    h = max(0.05, min(1.0 - y, float(region.get("h", 0.32))))
    cw = f"trunc(iw*{w:.4f}/2)*2"
    ch = f"trunc(ih*{h:.4f}/2)*2"
    cx = f"trunc(iw*{x:.4f}/2)*2"
    cy = f"trunc(ih*{y:.4f}/2)*2"
    return f"crop={cw}:{ch}:{cx}:{cy}"


def resolve_layout(layout: str, region: dict) -> str:
    if layout in ("facecam", "gameplay", "full", "split"):
        return layout
    try:
        return "gameplay" if float(region.get("w", 0.28)) < 0.7 else "facecam"
    except (TypeError, ValueError):
        return "gameplay"


def vertical_filter(layout: str, region: dict, srt_name: str | None = None):
    cam = crop_expr(region)
    blur = ("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
            "scale=270:480,gblur=sigma=7,scale=1080:1920")

    if layout == "facecam":
        parts = [
            f"[0:v]{cam},{blur}[bg]",
            f"[0:v]{cam},scale=1080:-2[cam]",
            "[bg][cam]overlay=(W-w)/2:(H-h)/2[v]",
        ]
    elif layout == "split":
        parts = [
            "[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[top]",
            f"[0:v]{cam},scale=1080:840:force_original_aspect_ratio=increase,crop=1080:840[bot]",
            "[top][bot]vstack=inputs=2[v]",
        ]
    elif layout == "full":
        parts = [
            f"[0:v]{blur}[bg]",
            "[0:v]scale=1080:-2[fg]",
            "[bg][fg]overlay=(W-w)/2:(H-h)/2[v]",
        ]
    else:
        parts = [
            f"[0:v]{blur}[bg]",
            f"[0:v]{cam},scale=464:372:force_original_aspect_ratio=increase,crop=464:372[cam]",
            "[bg][cam]overlay=56:1536:format=auto[v]",
        ]

    if srt_name:
        style = ("FontSize=17,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
                 "BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=110,Bold=1")
        parts.append(f"[v]subtitles={srt_name}:force_style='{style}'[vo]")
        return ";".join(parts), "[vo]"
    return ";".join(parts), "[v]"


def render_clip(src: Path, out_dir: Path, name: str, seek: float, duration: float,
                layout: str, region: dict, srt_text: str = "") -> Path:
    if not FFMPEG:
        raise RuntimeError("ffmpeg is not installed")

    srt_name = None
    srt_file = out_dir / "captions.srt"
    if srt_text:
        srt_file.write_text(srt_text, encoding="utf-8")
        srt_name = "captions.srt"
    elif srt_file.exists():
        srt_file.unlink()

    fc, vout = vertical_filter(layout, region, srt_name)
    # Fix A/V sync: -itsoffset is an input option; place it before -i so ffmpeg
    # applies the timestamp offset to the source before the filter graph runs.
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
    if seek > 0:
        cmd += ["-ss", f"{seek:.3f}"]
    cmd += ["-itsoffset", "0", "-i", str(src),
            "-t", f"{max(1.0, duration):.3f}",
            "-filter_complex", fc,
            "-map", vout,
            "-map", "0:a?",
    ]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        name,
    ]
    code, _, err = run(cmd, cwd=out_dir, timeout=3600)
    out_path = out_dir / name
    if code != 0 or not out_path.exists() or out_path.stat().st_size < 4096:
        raise RuntimeError(tail(err, 3) or "ffmpeg could not render the clip")
    return out_path


# ───────────────────────────── job pipeline ─────────────────────────────
def set_stage(job: dict, stage: str, label: str, pct: int):
    with JOBS_LOCK:
        job.update(stage=stage, label=label, pct=max(0, min(100, int(pct))), updated=time.time())


def fetch_audio(url: str, work: Path, job=None) -> Path | None:
    run([YTDLP, "-f", "bestaudio/best", "--no-playlist", "--no-warnings",
         "-o", str(work / "audio.%(ext)s"), url], timeout=7200, job=job)
    for path in sorted(work.glob("audio.*")):
        if path.suffix.lower() not in (".part", ".ytdl") and path.stat().st_size > 2048:
            return path
    return None


def fetch_section(url: str, start: float, end: float, work: Path, index: int, job=None) -> tuple[Path | None, float]:
    """Download ~8s of overlap before the window so the cut can be frame exact."""
    pad = 8.0 if start > 8 else start
    section_start = max(0.0, start - pad)
    tpl = str(work / f"part{index}.%(ext)s")
    run([
        YTDLP, "--no-playlist", "--no-warnings",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
        "--download-sections", f"*{fmt_time(section_start)}-{fmt_time(end + 2)}",
        "-o", tpl, url,
    ], timeout=3600, job=job)
    for path in sorted(work.glob(f"part{index}.*")):
        if path.suffix.lower() not in (".part", ".ytdl") and path.stat().st_size > 4096:
            return path, start - section_start
    return None, 0.0


def clean_title(title: str, start: float) -> str:
    base = re.sub(r"\s+", " ", (title or "Clip")).strip()
    base = re.sub(r"\.(mp4|mkv|webm|mov|m4v)$", "", base, flags=re.I)
    if len(base) > 62:
        base = base[:59].rstrip() + "…"
    return f"{base} · {fmt_time(start)}"


def show_review(job: dict, src_path, url: str, work: Path, duration: float, windows, preview):
    """Grab review frames, guess the facecam box, then wait for the user's approval."""
    times = shot_times(duration, windows)
    frames = Frames(src_path, url, work, job, preview)
    found: list[dict] = []
    for i, at in enumerate(times):
        if job.get("cancelled"):
            raise Cancelled()
        set_stage(job, "shots", f"Taking screenshot {i + 1} of {len(times)}",
                  40 + int(12 * i / max(1, len(times))))
        item = frames.shot(at, i)
        if item:
            found.append(item)
    if not found:
        raise RuntimeError("could not read a frame from that video")

    shots = []
    previous = None
    for item in found:
        guess = detect_facecam([item["pair"]]) or {}
        region = clean_region(guess.get("facecam") or DEFAULT_REGION)
        shots.append({
            "at": item["at"],
            "image": f"/api/shot/{job['id']}/{item['image']}" if item["image"] else "",
            "facecam": region,
            "confidence": guess.get("confidence", 0),
            "changed": bool(previous and iou(previous, region) < 0.5),
        })
        previous = region

    gate = threading.Event()
    with JOBS_LOCK:
        job["review"] = {"shots": shots, "duration": duration}
        job["awaiting"] = True
        job["gate"] = gate
    set_stage(job, "review", "Waiting for your layout check", 54)
    gate.wait(timeout=3600)
    with JOBS_LOCK:
        job["awaiting"] = False
        job["gate"] = None
        approval = job.get("approval") or {}
    if job.get("cancelled"):
        raise Cancelled()
    if not approval:
        raise RuntimeError("no layout approval came back, so nothing was cut")

    approved_shots = [s for s in (approval.get("shots") or [])
                      if isinstance(s, dict) and isinstance(s.get("facecam"), dict)]
    return {
        "layout": str(approval.get("layout") or "gameplay"),
        "facecam": clean_region(approval.get("facecam") or {}),
        "shots": approved_shots,
    }


def run_job(job_id: str, payload: dict):
    job = JOBS[job_id]
    work = CACHE_DIR / f"job-{job_id}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        if not FFMPEG:
            raise RuntimeError("ffmpeg is not on PATH — install it, then restart the engine")

        url = str(payload.get("url") or "").strip()
        upload = str(payload.get("upload") or "").strip()
        count = int(payload.get("count") or 3)
        min_len = int(payload.get("minLen") or 30)
        max_len = int(payload.get("maxLen") or 80)
        layout = str(payload.get("layout") or "auto")
        region = payload.get("facecam") or {}
        caps = payload.get("captions") or {}
        want_caps = bool(caps.get("on", True))
        cap_mode = str(caps.get("mode") or "burn")

        src_path: Path | None = None
        preview = None
        if upload:
            candidate = (ROOT / unquote(upload)).resolve()
            if not str(candidate).startswith(str(UPLOAD_DIR.resolve())) or not candidate.exists():
                raise RuntimeError("the uploaded file is gone")
            src_path = candidate
            with JOBS_LOCK:
                job["upload"] = upload
            set_stage(job, "fetch", "Reading the uploaded file", 8)
            meta = {"title": src_path.stem, "duration": probe_duration(src_path), "thumbnail": ""}
        else:
            if not url:
                raise RuntimeError("no link or file given")
            set_stage(job, "fetch", "Reading the video", 6)
            meta = analyze(url, want_preview=True)
        preview = meta.pop("_preview", None)
        with JOBS_LOCK:
            job["meta"] = meta

        duration = float(meta.get("duration") or 0)

        set_stage(job, "audio", "Listening to the audio", 20)
        audio_src = src_path
        if audio_src is None:
            audio_src = fetch_audio(url, work, job)
        curve = audio_curve(audio_src, work) if audio_src else []
        if not duration:
            duration = float(len(curve))
        if not duration:
            raise RuntimeError("could not read the video length")

        set_stage(job, "plan", "Scoring the best moments", 36)
        windows = plan_windows(curve, duration, count, min_len, max_len)
        with JOBS_LOCK:
            job["windows"] = list(windows)
        if job.get("cancelled"):
            raise Cancelled()

        approval = show_review(job, src_path, url, work, duration, windows, preview)
        layout = approval["layout"]
        region = approval["facecam"]
        region_shots = approval["shots"]

        srt_text = ""
        if want_caps and src_path is None:
            set_stage(job, "plan", "Fetching captions", 42)
            sub_file = fetch_subs(url, work)
            if sub_file:
                srt_text = sub_file.read_text(encoding="utf-8", errors="replace")

        burn_ok = want_caps and cap_mode == "burn" and has_subtitle_filter()
        chosen_layout = resolve_layout(layout, region)
        out_dir = CLIPS_DIR / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        clips: list[dict] = []

        for i, window in enumerate(windows):
            if job.get("cancelled"):
                raise Cancelled()
            start, end = float(window["start"]), float(window["end"])
            length = max(1.0, end - start)
            clip_region = region_for(start, region_shots, region)
            set_stage(job, "cut", f"Cutting clip {i + 1} of {len(windows)}",
                      58 + int(40 * i / max(1, len(windows))))

            if src_path is not None:
                part, seek = src_path, start
            else:
                part, seek = fetch_section(url, start, end, work, i, job)
            if job.get("cancelled"):
                raise Cancelled()
            if part is None:
                raise RuntimeError(f"download failed for clip {i + 1}")

            srt_slice = slice_srt(srt_text, start, end) if (srt_text and want_caps) else ""
            name = f"clip-{i + 1}.mp4"
            render_clip(part, out_dir, name, seek, length, chosen_layout, clip_region,
                        srt_slice if burn_ok else "")

            entry = {
                "file": f"/clips/{job_id}/{name}",
                "title": clean_title(meta.get("title", ""), start),
                "start": round(start, 2),
                "end": round(end, 2),
                "score": round(float(window.get("score") or 82)),
                "layout": chosen_layout,
                "burnedCaptions": bool(burn_ok and srt_slice),
            }
            if srt_slice:
                (out_dir / f"clip-{i + 1}.srt").write_text(srt_slice, encoding="utf-8")
                entry["srt"] = f"/clips/{job_id}/clip-{i + 1}.srt"
            clips.append(entry)
            with JOBS_LOCK:
                job["clips"] = list(clips)

            if src_path is None and part.name.startswith("part"):
                try:
                    part.unlink()
                except OSError:
                    pass

        set_stage(job, "done", "Done", 100)
        with JOBS_LOCK:
            job["done"] = True
    except Cancelled:
        with JOBS_LOCK:
            job.update(done=True, stage="stopped", label="Stopped", pct=100)
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI
        with JOBS_LOCK:
            job.update(done=True, error=str(exc), stage="error", label=str(exc)[:300], pct=100)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ───────────────────────────── live sessions ─────────────────────────────
MEDIA_SUFFIXES = (".m3u8", ".mpd", ".flv", ".ts")


def looks_like_media(url: str) -> bool:
    """A bare playlist/stream URL can be recorded directly, without yt-dlp."""
    try:
        return urlparse(url).path.lower().endswith(MEDIA_SUFFIXES)
    except ValueError:
        return False


def ff_headers(headers) -> list[str]:
    args: list[str] = []
    headers = headers or {}
    ua = headers.get("User-Agent")
    if ua:
        args += ["-user_agent", str(ua)]
    extra = "".join(f"{k}: {v}\r\n" for k, v in headers.items() if str(k).lower() != "user-agent")
    if extra:
        args += ["-headers", extra]
    return args


def live_target(url: str) -> dict:
    """Resolve a watch link to something ffmpeg can read right now."""
    if looks_like_media(url):
        name = Path(urlparse(url).path).stem or "Live stream"
        return {"media": url, "headers": {}, "audio": "", "title": name, "duration": 0.0,
                "page": url, "thumbnail": ""}
    if not YTDLP:
        raise RuntimeError("yt-dlp is not installed, so the stream link cannot be opened")
    meta = analyze(url, want_preview=True)
    preview = meta.pop("_preview", None) or {}
    media = str(preview.get("url") or "")
    if not media:
        if meta.get("isLive") is False:
            raise RuntimeError("that link is not live right now — paste the live stream itself, "
                               "or use the Studio tab for a past broadcast")
        raise RuntimeError("the stream was found but no playable format came back — try again in a moment")
    return {"media": media, "headers": preview.get("headers") or {},
            "audio": str(preview.get("audio") or ""),
            "title": meta.get("title") or "Live stream",
            "duration": float(meta.get("duration") or 0),
            "page": meta.get("webpage") or url,
            "thumbnail": meta.get("thumbnail") or ""}


def live_still(media: str, headers, work: Path, key: str, tag: str):
    """One JPEG plus a 160x90 gray frame from the live edge."""
    base = ([FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
            + ff_headers(headers) + ["-rw_timeout", "20000000", "-i", media])
    jpg = work / f"{tag}.jpg"
    gray = work / f"{tag}.gray"
    code, _, _ = run(base + ["-frames:v", "1", "-update", "1",
                             "-vf", f"scale={SHOT_JPEG_W}:-2", "-q:v", "4", str(jpg)],
                     job={"id": key}, timeout=180)
    if code != 0 or not jpg.exists() or jpg.stat().st_size < 1024:
        return None, None
    code, _, _ = run(base + ["-frames:v", "1", "-vf", f"scale={SHOT_W}:{SHOT_H}",
                             "-pix_fmt", "gray", "-f", "rawvideo", str(gray)],
                     job={"id": key}, timeout=180)
    data = b""
    if code == 0 and gray.exists():
        data = gray.read_bytes()[: SHOT_W * SHOT_H]
    return jpg, (data if len(data) == SHOT_W * SHOT_H else None)


def live_pair(media: str, headers, work: Path, key: str, index: int):
    """Two frames a second apart: enough motion to guess the facecam corner."""
    first, first_gray = live_still(media, headers, work, key, f"live{index}a")
    if first is None:
        return None
    time.sleep(1.0)
    _, second_gray = live_still(media, headers, work, key, f"live{index}b")
    guess = detect_facecam([(first_gray, second_gray)]) if (first_gray and second_gray) else None
    return {"image": first, "facecam": clean_region((guess or {}).get("facecam") or DEFAULT_REGION),
            "confidence": (guess or {}).get("confidence", 0)}


def live_find(session: dict, cid: str):
    for item in session.get("pending") or []:
        if item.get("id") == cid:
            return item
    return None


def live_nearest_region(session: dict) -> dict:
    shots = session.get("shots") or []
    if shots:
        return clean_region(shots[-1].get("facecam") or {})
    return clean_region(session.get("facecam") or {})


def live_stop(session: dict) -> None:
    """Stop watching and kill its frame grabs and recorders."""
    with LIVE_LOCK:
        session["cancelled"] = True
        session["status"] = "stopped"
        session["label"] = "Stopped watching"
    with JOBS_LOCK:
        keys = [k for k in PROCS if k == session.get("id") or k.startswith(f"{session.get('id')}:")]
        procs = [PROCS[k] for k in keys]
    for proc in procs:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass


def run_live(live_id: str, payload: dict) -> None:
    session = LIVE[live_id]
    work = CACHE_DIR / f"live-{live_id}"
    work.mkdir(parents=True, exist_ok=True)
    key = f"{live_id}:shot"
    try:
        if not FFMPEG:
            raise RuntimeError("ffmpeg is not on PATH — install it, then restart the engine")
        url = str(payload.get("url") or "").strip()
        if not url:
            raise RuntimeError("no stream link given")
        with LIVE_LOCK:
            session.update(status="connecting", label="Reading the stream")
        target = live_target(url)
        with LIVE_LOCK:
            session["media"] = target["media"]
            session["audio"] = target.get("audio") or ""
            session["headers"] = target["headers"]
            session["meta"] = {"title": target["title"], "duration": target["duration"],
                              "thumbnail": target["thumbnail"], "page": target["page"]}
            session.update(status="watching", label="Watching the stream")

        index = 0
        while not session.get("cancelled"):
            pair = live_pair(str(session.get("media") or ""), session.get("headers") or {},
                             work, key, index)
            index += 1
            if pair is not None:
                with LIVE_LOCK:
                    previous = session["shots"][-1] if session.get("shots") else None
                    changed = bool(previous and iou(previous["facecam"], pair["facecam"]) < 0.55)
                    if previous is None or changed:
                        session["shots"].append({
                            "at": round(time.time() - session["started"], 1),
                            "image": f"/api/live/{live_id}/shot/{pair['image'].name}",
                            "facecam": pair["facecam"],
                            "confidence": pair["confidence"],
                            "changed": changed,
                            "note": "first frame" if previous is None else "the camera looks like it moved",
                        })
                        if changed:
                            session["label"] = "Camera looks like it moved — new screenshot"
                        elif previous is None:
                            session["label"] = "First screenshot ready — adjust the box anytime"
            else:
                with LIVE_LOCK:
                    session["label"] = "Waiting for a frame from the stream"
            for _ in range(int(LIVE_SAMPLE_SECONDS * 2)):
                if session.get("cancelled"):
                    break
                time.sleep(0.5)
        with LIVE_LOCK:
            if session.get("status") != "error":
                session.update(status="stopped", label="Stopped watching")
    except Cancelled:
        with LIVE_LOCK:
            session.update(status="stopped", label="Stopped watching")
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI
        with LIVE_LOCK:
            session.update(status="error", error=str(exc), label=str(exc)[:300])


def live_capture(session: dict, length: int) -> dict:
    """Start recording the live edge at once; only the cut waits for approval."""
    with LIVE_LOCK:
        cid = f"c{len(session.get('pending') or []) + 1}"
        item = {
            "id": cid,
            "length": max(5, int(length)),
            "status": "recording",
            "approved": False,
            "at": round(time.time() - session["started"], 1),
            "region": live_nearest_region(session),
            "image": (session["shots"][-1]["image"] if session.get("shots") else ""),
            "created": time.time(),
            "file": "",
        }
        session["pending"].append(item)
        session["label"] = "Recording the moment"
    threading.Thread(target=live_record_clip, args=(session, item), daemon=True).start()
    return item


def live_record_clip(session: dict, item: dict) -> None:
    work = CACHE_DIR / f"live-{session['id']}"
    src = work / f"{item['id']}.mp4"
    media = str(session.get("media") or "")
    headers = session.get("headers") or {}
    seconds = max(4, int(item["length"]) + 1)
    key = f"{session['id']}:{item['id']}"
    audio_media = str(session.get("audio") or "")
    base = ([FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + ff_headers(headers)
            + ["-rw_timeout", "20000000", "-i", media])
    if audio_media:
        # Pull the separate audio rendition too: the video-only live edge has no sound.
        base += (ff_headers(headers) + ["-rw_timeout", "20000000", "-i", audio_media]
                 + ["-map", "0:v:0", "-map", "1:a:0"])
    base += ["-t", f"{seconds}", "-movflags", "+faststart"]
    code, _, err = run(base + ["-c", "copy", str(src)], job={"id": key}, timeout=seconds + 600)
    if code != 0 or not src.exists() or src.stat().st_size < 8192:
        code, _, err = run(
            base + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(src)],
            job={"id": key}, timeout=seconds + 900,
        )
    with LIVE_LOCK:
        dropped = session.get("cancelled") or item.get("status") == "dropped"
    if dropped:
        with LIVE_LOCK:
            item["status"] = "dropped"
        try:
            src.unlink(missing_ok=True)
        except OSError:
            pass
        return
    if code != 0 or not src.exists() or src.stat().st_size < 4096:
        with LIVE_LOCK:
            item["status"] = "error"
            item["error"] = tail(err) or "the stream stopped before the clip was recorded"
        return
    with LIVE_LOCK:
        item["src"] = str(src)
        item["status"] = "buffered"
        item["label"] = "Recorded — waiting for your OK"
        approved = bool(item.get("approved"))
    if approved:
        live_render(session, item)


def live_render(session: dict, item: dict) -> None:
    src = Path(item.get("src") or "")
    out_dir = CLIPS_DIR / f"live-{session['id']}"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{item['id']}.mp4"
    layout = str(session.get("layout") or "gameplay")
    region = clean_region(item.get("region") or {})
    with LIVE_LOCK:
        item["status"] = "cutting"
        item["label"] = "Cutting the clip"
    try:
        render_clip(src, out_dir, name, 0.0, max(1.0, float(item["length"])), layout, region, "")
    except Exception as exc:  # noqa: BLE001
        with LIVE_LOCK:
            item["status"] = "error"
            item["error"] = str(exc)
        return

    base = re.sub(r"\s+", " ", str((session.get("meta") or {}).get("title") or "Live clip")).strip()
    if len(base) > 58:
        base = base[:55].rstrip() + "…"
    entry = {
        "file": f"/clips/live-{session['id']}/{name}",
        "title": f"{base} · live {fmt_time(item.get('at') or 0)}",
        "start": round(float(item.get("at") or 0), 1),
        "end": round(float(item.get("at") or 0) + float(item["length"]), 1),
        "score": 90,
        "layout": layout,
        "burnedCaptions": False,
        "live": True,
    }
    with LIVE_LOCK:
        item["status"] = "ready"
        item["file"] = entry["file"]
        item["label"] = "Clip ready"
        session["clips"].append(entry)
        session["label"] = "Clip cut — still watching"


def live_snapshot(session: dict) -> dict:
    with LIVE_LOCK:
        pending = []
        for item in session.get("pending") or []:
            pending.append({k: item.get(k) for k in
                            ("id", "length", "status", "label", "image", "region", "at",
                             "approved", "error", "file")})
        return {
            "id": session.get("id"),
            "status": session.get("status"),
            "label": session.get("label"),
            "error": session.get("error", ""),
            "meta": session.get("meta") or {},
            "shots": list(session.get("shots") or []),
            "pending": pending,
            "clips": list(session.get("clips") or []),
            "elapsed": round(time.time() - session["started"], 1),
            "sampleSeconds": LIVE_SAMPLE_SECONDS,
        }


# ───────────────────────────── storage / cleanup ─────────────────────────────
def path_stats(root: Path) -> dict:
    total = 0
    files = 0
    if root.exists():
        for path in root.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
                    files += 1
            except OSError:
                continue
    return {"bytes": total, "files": files}


def busy_work_dirs() -> set[str]:
    with JOBS_LOCK:
        names = {f"job-{jid}" for jid, job in JOBS.items() if not job.get("done")}
    with LIVE_LOCK:
        names |= {f"live-{lid}" for lid, session in LIVE.items() if session.get("status") != "stopped"}
    return names


def busy_clip_dirs() -> set[str]:
    with JOBS_LOCK:
        names = {jid for jid, job in JOBS.items() if not job.get("done")}
    with LIVE_LOCK:
        names |= {f"live-{lid}" for lid, session in LIVE.items() if session.get("status") != "stopped"}
    return names


def storage_info() -> dict:
    return {
        "cache": path_stats(CACHE_DIR),
        "clips": path_stats(CLIPS_DIR),
        "uploads": path_stats(UPLOAD_DIR),
        "busy": sorted(busy_work_dirs()),
    }


def remove_path(path: Path) -> int:
    freed = 0
    try:
        if path.is_dir():
            for child in path.rglob("*"):
                if child.is_file():
                    freed += child.stat().st_size
            shutil.rmtree(path, ignore_errors=True)
        elif path.is_file():
            freed += path.stat().st_size
            path.unlink(missing_ok=True)
    except OSError:
        pass
    return freed


def clear_storage(what) -> dict:
    wanted = {str(w) for w in (what or [])}
    freed = 0
    removed = 0
    if "cache" in wanted:
        skip = busy_work_dirs()
        for entry in list(CACHE_DIR.iterdir()):
            if entry.name in skip:
                continue
            freed += remove_path(entry)
            removed += 1
    if "clips" in wanted:
        skip = busy_clip_dirs()
        for entry in list(CLIPS_DIR.iterdir()):
            if entry.name in skip:
                continue
            freed += remove_path(entry)
            removed += 1
    if "uploads" in wanted:
        with JOBS_LOCK:
            skip_files = {Path(job.get("upload") or "").name for job in JOBS.values() if not job.get("done")}
        for entry in list(UPLOAD_DIR.iterdir()):
            if entry.name in skip_files:
                continue
            freed += remove_path(entry)
            removed += 1
    return {"freed": freed, "removed": removed, **storage_info()}


def delete_output(rel: str) -> dict:
    """Remove one rendered clip, sidecar or upload from disk."""
    raw = str(rel or "").strip()
    if not raw:
        raise RuntimeError("no file given")
    clean = unquote(urlparse(raw).path)
    target = (ROOT / clean.lstrip("/")).resolve()
    allowed = (CLIPS_DIR.resolve(), UPLOAD_DIR.resolve())
    if not any(str(target).startswith(str(base)) for base in allowed):
        raise RuntimeError("that file is not a clip or an upload")
    if not target.is_file():
        return {"ok": True, "freed": 0}
    if target.suffix.lower() == ".mp4":
        sidecar = target.with_suffix(".srt")
        if sidecar.exists():
            remove_path(sidecar)
    freed = remove_path(target)
    parent = target.parent
    try:
        if parent not in (CLIPS_DIR, UPLOAD_DIR) and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    return {"ok": True, "freed": freed}


# ───────────────────────────── HTTP layer ─────────────────────────────
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".srt": "application/x-subrip; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"SliceEngine/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep polling quiet
        if "/api/jobs/" in (self.path or ""):
            return
        sys.stdout.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    # ── helpers ──
    def send_json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def serve_path(self, rel: str):
        target = (ROOT / rel.lstrip("/")).resolve()
        if not str(target).startswith(str(ROOT)) or not target.is_file():
            return self.send_json({"error": "not found"}, 404)

        size = target.stat().st_size
        start, end = 0, size - 1
        code = 200
        header = self.headers.get("Range") or ""
        if header.startswith("bytes="):
            first = header[6:].split(",")[0]
            a, _, b = first.partition("-")
            try:
                if a:
                    start = int(a)
                    end = int(b) if b else size - 1
                elif b:
                    start = max(0, size - int(b))
            except ValueError:
                start, end = 0, size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))
            code = 206

        self.send_response(code)
        self.send_header("Content-Type", MIME.get(target.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        with target.open("rb") as handle:
            handle.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = handle.read(min(262144, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return
                remaining -= len(chunk)

    # ── routes ──
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            return self.send_json({
                "ok": True,
                "engine": "neonclip-local",
                "version": VERSION,
                "ffmpeg": bool(FFMPEG),
                "ffprobe": bool(FFPROBE),
                "ytdlp": bool(YTDLP),
                "captions": has_subtitle_filter(),
                "python": sys.version.split()[0],
            })

        if path == "/api/analyze":
            url = (parse_qs(parsed.query).get("url") or [""])[0].strip()
            if not url:
                return self.send_json({"error": "url required"}, 400)
            try:
                return self.send_json(analyze(url))
            except Exception as exc:  # noqa: BLE001
                return self.send_json({"error": str(exc)}, 502)

        if path.startswith("/api/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            job = JOBS.get(job_id)
            if not job:
                return self.send_json({"error": "unknown job"}, 404)
            with JOBS_LOCK:
                return self.send_json({
                    "id": job_id,
                    "stage": job.get("stage", "queued"),
                    "label": job.get("label", "Queued"),
                    "pct": job.get("pct", 0),
                    "done": bool(job.get("done")),
                    "error": job.get("error", ""),
                    "awaiting": bool(job.get("awaiting")),
                    "review": job.get("review", {}) if job.get("awaiting") else {},
                    "cancelled": bool(job.get("cancelled")),
                    "clips": job.get("clips", []),
                    "meta": job.get("meta", {}),
                })

        if path == "/api/storage":
            return self.send_json(storage_info())

        if path.startswith("/api/live/"):
            rest = path[len("/api/live/"):]
            parts = rest.split("/")
            session = LIVE.get(parts[0])
            if not session:
                return self.send_json({"error": "unknown live session"}, 404)
            if len(parts) == 1:
                return self.send_json(live_snapshot(session))
            if len(parts) == 3 and parts[1] == "shot":
                name = parts[2]
                if not re.fullmatch(r"live\d+[ab]\.jpg", name):
                    return self.send_json({"error": "not found"}, 404)
                return self.serve_path(f".cache/live-{parts[0]}/{name}")
            return self.send_json({"error": "not found"}, 404)

        if path.startswith("/api/thumb/"):
            return self.serve_path(f".cache/{path.rsplit('/', 1)[-1]}")

        if path.startswith("/api/shot/"):
            parts = path[len("/api/shot/"):].split("/")
            if len(parts) != 2:
                return self.send_json({"error": "not found"}, 404)
            job_id, name = parts
            if not re.fullmatch(r"[a-f0-9]{6,32}", job_id) or not re.fullmatch(r"shot\d+[ab]\.jpg", name):
                return self.send_json({"error": "not found"}, 404)
            return self.serve_path(f".cache/job-{job_id}/shots/{name}")

        if path in ("/", ""):
            return self.serve_path("index.html")
        return self.serve_path(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/clips":
            payload = self.read_json()
            job_id = uuid.uuid4().hex[:12]
            JOBS[job_id] = {"id": job_id, "stage": "queued", "label": "Queued", "pct": 0,
                            "done": False, "clips": [], "created": time.time(),
                            "awaiting": False, "review": {}, "approval": None,
                            "gate": None, "cancelled": False}
            threading.Thread(target=run_job, args=(job_id, payload), daemon=True).start()
            return self.send_json({"id": job_id}, 202)

        if path == "/api/live":
            payload = self.read_json()
            url = str(payload.get("url") or "").strip()
            if not url:
                return self.send_json({"error": "no stream link given"}, 400)
            live_id = uuid.uuid4().hex[:12]
            LIVE[live_id] = {
                "id": live_id, "url": url, "status": "starting", "label": "Starting",
                "done": False, "cancelled": False, "error": "", "meta": {},
                "shots": [], "pending": [], "clips": [], "started": time.time(),
                "layout": str(payload.get("layout") or "auto"),
                "facecam": clean_region(payload.get("facecam") or {}),
                "captions": payload.get("captions") or {"on": True, "mode": "burn"},
                "media": "", "headers": {},
            }
            threading.Thread(target=run_live, args=(live_id, payload), daemon=True).start()
            return self.send_json({"id": live_id}, 202)

        if path == "/api/storage/clear":
            payload = self.read_json()
            return self.send_json(clear_storage(payload.get("what") or []))

        if path == "/api/storage/delete":
            payload = self.read_json()
            try:
                return self.send_json(delete_output(str(payload.get("file") or "")))
            except Exception as exc:  # noqa: BLE001
                return self.send_json({"error": str(exc)}, 400)

        if path.startswith("/api/live/") and path.endswith("/stop"):
            live_id = path.rsplit("/", 2)[-2]
            session = LIVE.get(live_id)
            if session:
                live_stop(session)
            return self.send_json({"ok": bool(session)})

        if path.startswith("/api/live/") and (path.endswith("/capture") or path.endswith("/spike")):
            live_id = path.rsplit("/", 2)[-2]
            session = LIVE.get(live_id)
            if not session:
                return self.send_json({"error": "unknown live session"}, 404)
            if session.get("cancelled"):
                return self.send_json({"error": "this session was stopped"}, 409)
            if not session.get("media"):
                return self.send_json({"error": "the stream is not ready yet"}, 409)
            payload = self.read_json()
            try:
                length = int(payload.get("length") or 25)
            except (TypeError, ValueError):
                length = 25
            item = live_capture(session, length)
            return self.send_json({"pending": {k: item.get(k) for k in
                                                ("id", "length", "status", "image", "region", "at")}})

        if path.startswith("/api/live/") and "/pending/" in path:
            tail_parts = path[len("/api/live/"):].split("/")
            if len(tail_parts) != 4 or tail_parts[1] != "pending" \
                    or tail_parts[3] not in ("approve", "reject"):
                return self.send_json({"error": "not found"}, 404)
            live_id, cid, action = tail_parts[0], tail_parts[2], tail_parts[3]
            session = LIVE.get(live_id)
            if not session:
                return self.send_json({"error": "unknown live session"}, 404)
            item = live_find(session, cid)
            if not item:
                return self.send_json({"error": "unknown clip"}, 404)

            if action == "reject":
                with LIVE_LOCK:
                    item["status"] = "dropped"
                remove_path(Path(item.get("src") or "")) if item.get("src") else None
                return self.send_json({"ok": True})

            payload = self.read_json()
            shots = []
            for shot in (payload.get("shots") or [])[:12]:
                if not isinstance(shot, dict):
                    continue
                try:
                    at = float(shot.get("at") or 0)
                except (TypeError, ValueError):
                    continue
                shots.append({"at": round(at, 2), "facecam": clean_region(shot.get("facecam") or {})})
            with LIVE_LOCK:
                session["layout"] = str(payload.get("layout") or session.get("layout") or "gameplay")
                if shots:
                    session["shots"] = [
                        {**old, "facecam": next((s["facecam"] for s in shots
                                                 if abs(s["at"] - float(old.get("at") or 0)) < 0.6),
                                                old.get("facecam"))}
                        for old in session.get("shots") or []
                    ]
                item["region"] = clean_region(payload.get("facecam") or item.get("region") or {})
                item["approved"] = True
                ready = item.get("status") == "buffered"
                item["label"] = "Approved — cutting" if ready else "Approved — cutting when the recording ends"
            if ready:
                threading.Thread(target=live_render, args=(session, item), daemon=True).start()
            return self.send_json({"ok": True, "status": item.get("status")})

        if path == "/api/upload":
            name = (parse_qs(parsed.query).get("name") or ["input.mp4"])[0]
            safe = re.sub(r"[^A-Za-z0-9._-]+", "-", unquote(name)).strip(".-") or "input.mp4"
            token = f"{uuid.uuid4().hex[:8]}-{safe}"
            dest = UPLOAD_DIR / token
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return self.send_json({"error": "empty upload"}, 400)
            remaining = length
            with dest.open("wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(1048576, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            if remaining > 0:
                dest.unlink(missing_ok=True)
                return self.send_json({"error": "upload interrupted"}, 400)
            return self.send_json({"upload": f"uploads/{token}", "bytes": length})

        if path.startswith("/api/jobs/") and path.endswith("/cancel"):
            job_id = path.rsplit("/", 2)[-2]
            job = JOBS.get(job_id)
            if job:
                cancel_job(job)
            return self.send_json({"ok": bool(job)})

        if path.startswith("/api/jobs/") and path.endswith("/approve"):
            job_id = path.rsplit("/", 2)[-2]
            job = JOBS.get(job_id)
            if not job:
                return self.send_json({"error": "unknown job"}, 404)
            if job.get("cancelled"):
                return self.send_json({"error": "that job was stopped"}, 409)
            payload = self.read_json()
            shots = []
            for shot in (payload.get("shots") or [])[:12]:
                if not isinstance(shot, dict):
                    continue
                try:
                    at = float(shot.get("at") or 0)
                except (TypeError, ValueError):
                    continue
                shots.append({"at": round(at, 2), "facecam": clean_region(shot.get("facecam") or {})})
            with JOBS_LOCK:
                job["approval"] = {
                    "layout": str(payload.get("layout") or "gameplay"),
                    "facecam": clean_region(payload.get("facecam") or {}),
                    "shots": shots,
                }
                gate = job.get("gate")
            if gate is not None:
                gate.set()
            return self.send_json({"ok": True, "shots": len(shots)})

        return self.send_json({"error": "not found"}, 404)


# ───────────────────────────── self test ─────────────────────────────
def selftest() -> int:
    print(f"python  {sys.version.split()[0]}")
    print(f"ffmpeg  {FFMPEG or 'MISSING'}")
    print(f"ffprobe {FFPROBE or 'MISSING'}")
    print(f"yt-dlp  {YTDLP or 'MISSING'}")
    print(f"subtitles filter: {has_subtitle_filter()}")
    failures = 0
    if not FFMPEG:
        print("FAIL  ffmpeg is required")
        return 1

    work = CACHE_DIR / "selftest"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)

    sample = work / "sample.mp4"
    code, _, err = run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=36",
        "-f", "lavfi", "-i", "sine=frequency=420:duration=36:sample_rate=44100",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(sample),
    ], timeout=180)
    print(("PASS" if code == 0 and sample.exists() else "FAIL") + "  generated a 16:9 test video")
    if code != 0:
        print("      " + tail(err))
        failures += 1
        return failures

    curve = audio_curve(sample, work)
    ok = 30 <= len(curve) <= 40
    print(("PASS" if ok else "FAIL") + f"  loudness curve has {len(curve)} one-second buckets")
    failures += 0 if ok else 1

    windows = plan_windows(curve, 36, 2, 10, 16)
    ok = len(windows) == 2 and all(0 <= w["start"] < w["end"] <= 36 for w in windows)
    print(("PASS" if ok else "FAIL") + f"  planned {len(windows)} windows: " +
          ", ".join(f'{w["start"]:.0f}-{w["end"]:.0f}s' for w in windows))
    failures += 0 if ok else 1

    srt = ("1\n00:00:01,000 --> 00:00:03,000\nhello there\n\n"
           "2\n00:00:09,500 --> 00:00:11,000\nsecond line\n")
    sliced = slice_srt(srt, 9, 15)
    ok = "second line" in sliced and "hello there" not in sliced and sliced.startswith("1\n00:00:00,500")
    print(("PASS" if ok else "FAIL") + "  subtitle slice rebases to the clip window")
    failures += 0 if ok else 1

    # facecam detector: a calm box in the top-right of an otherwise moving frame
    calm = bytes([70] * (SHOT_W * SHOT_H))
    busy = bytearray(calm)
    for y in range(SHOT_H):
        for x in range(SHOT_W):
            if not (0.72 * SHOT_W <= x < 0.98 * SHOT_W and 0.02 * SHOT_H <= y < 0.34 * SHOT_H):
                busy[y * SHOT_W + x] = 210 if (x + y) % 2 else 30
    guess = detect_facecam([(calm, bytes(busy))]) or {}
    box = guess.get("facecam") or {}
    overlap = iou(box, {"x": 0.72, "y": 0.02, "w": 0.26, "h": 0.32}) if box else 0.0
    ok = overlap > 0.5
    print(("PASS" if ok else "FAIL") + f"  facecam guess lands on the calm corner box (IoU {overlap:.2f})")
    failures += 0 if ok else 1

    ok = len(shot_times(1200, [{"start": 350.0}])) == 7
    print(("PASS" if ok else "FAIL") + "  review screenshots spread over the video")
    failures += 0 if ok else 1

    for layout, region in (("gameplay", {"x": 0.03, "y": 0.62, "w": 0.28, "h": 0.32}),
                           ("split", {"x": 0.03, "y": 0.62, "w": 0.28, "h": 0.32}),
                           ("facecam", {"x": 0.36, "y": 0.1, "w": 0.3, "h": 0.3}),
                           ("full", {})):
        out_dir = work / layout
        out_dir.mkdir(exist_ok=True)
        try:
            render_clip(sample, out_dir, "clip.mp4", 4, 6, layout, region,
                        sliced if layout == "gameplay" else "")
            size = probe_size(out_dir / "clip.mp4")
            duration = probe_duration(out_dir / "clip.mp4")
            ok = size == "1080x1920" and 5.0 <= duration <= 7.5
            print(("PASS" if ok else "FAIL") + f"  {layout} render -> {size}, {duration:.1f}s")
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL  {layout} render: {exc}")
            ok = False
        failures += 0 if ok else 1

    print("selftest " + ("passed" if failures == 0 else f"failed ({failures})"))
    shutil.rmtree(work, ignore_errors=True)
    return 0 if failures == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="SliceEngine local engine")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SliceEngine engine {VERSION}")
    print(f"  ffmpeg {'ok' if FFMPEG else 'MISSING'}   yt-dlp {'ok' if YTDLP else 'MISSING'}"
          f"   captions {'ok' if has_subtitle_filter() else 'unavailable'}")
    print(f"  http://{args.host}:{args.port}/index.html")
    print("  Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

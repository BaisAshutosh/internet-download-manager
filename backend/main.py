import asyncio
import glob
import json
import sqlite3
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from yt_dlp import YoutubeDL

DB_FILE = "downloads.db"

# All active WebSocket connections
WS_CLIENTS: set[WebSocket] = set()

# ─── In-memory metadata cache ─────────────────────────────────────────────────
# {url: {"ts": timestamp, "data": {...}}}  — entries expire after 5 minutes
_META_CACHE: dict[str, dict] = {}
_META_CACHE_TTL = 300  # seconds


# ─── Database ────────────────────────────────────────────────────────────────

def init_db():
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS downloads (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            url        TEXT,
            filename   TEXT,
            title      TEXT    DEFAULT '',
            status     TEXT,
            progress   REAL,
            created_at TEXT
        )
    """)
    conn.commit()
    # Migrate existing DBs that pre-date the title column
    try:
        conn.execute("ALTER TABLE downloads ADD COLUMN title TEXT DEFAULT ''")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.close()


init_db()


def db_insert(url: str, filename: str, title: str = "") -> int:
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO downloads (url, filename, title, status, progress, created_at) "
        "VALUES (?, ?, ?, 'queued', 0, datetime('now'))",
        (url, filename, title),
    )
    row_id = cur.lastrowid
    conn.commit()
    conn.close()
    return row_id


def db_update(download_id: int, progress: float, status: str):
    conn = sqlite3.connect(DB_FILE)
    conn.execute(
        "UPDATE downloads SET progress=?, status=? WHERE id=?",
        (progress, status, download_id),
    )
    conn.commit()
    conn.close()


def db_list() -> list[dict]:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, url, filename, title, status, progress, created_at "
        "FROM downloads ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def db_delete(download_id: int) -> bool:
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute("DELETE FROM downloads WHERE id=?", (download_id,))
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def sanitize_filename(name: str) -> str:
    if not name:
        return ""
    cleaned = "".join(ch for ch in name if ch not in r'\/<>:?"| *')
    return "_".join(cleaned.strip().split())


# ─── Metadata / format helpers ────────────────────────────────────────────────

def _format_duration(seconds) -> str:
    """Convert raw seconds to HH:MM:SS or MM:SS string."""
    if not seconds:
        return ""
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s   = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _parse_formats(info: dict) -> list[dict]:
    """
    Return a clean, deduplicated list of download options from yt-dlp's
    raw formats list.

    Each entry:
        label       – shown in UI  (e.g. "1080p")
        format_str  – yt-dlp -f value to pass when downloading
        height      – int height, 0 for audio-only, None for best-auto
    """
    raw = info.get("formats") or []

    video_fmts = [
        f for f in raw
        if f.get("height") and f.get("vcodec", "none") != "none"
    ]
    has_audio_only = any(
        f.get("acodec", "none") != "none" and f.get("vcodec", "none") == "none"
        for f in raw
    )

    # For each unique height keep the highest-bitrate entry
    by_height: dict[int, dict] = {}
    for f in video_fmts:
        h   = int(f["height"])
        tbr = float(f.get("tbr") or f.get("vbr") or 0)
        if h not in by_height or tbr > float(by_height[h].get("tbr") or 0):
            by_height[h] = f

    result: list[dict] = [
        {"label": "Best (auto)", "format_str": "bestvideo+bestaudio/best", "height": None}
    ]

    for h in sorted(by_height.keys(), reverse=True):
        tag = f"4K ({h}p)" if h >= 2160 else f"{h}p"
        result.append({
            "label":      tag,
            "format_str": f"bestvideo[height<={h}]+bestaudio/best[height<={h}]",
            "height":     h,
        })

    if has_audio_only:
        result.append({"label": "Audio only", "format_str": "bestaudio/best", "height": 0})

    return result


def _extract_meta_sync(url: str) -> dict:
    """
    Run yt-dlp info extraction without downloading.  Called in a thread executor.
    Falls back gracefully to URL path heuristics on failure.
    """
    ydl_opts = {
        "quiet":            True,
        "no_warnings":      True,
        "skip_download":    True,
        "noplaylist":       True,
        "writeinfojson":    False,
        "writedescription": False,
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        return {
            "title":     info.get("title") or info.get("fulltitle") or "",
            "duration":  _format_duration(info.get("duration")),
            "formats":   _parse_formats(info),
            "thumbnail": info.get("thumbnail") or "",
            "source":    "yt_dlp",
        }

    except Exception as exc:
        # Fall back: derive a readable name from the URL path
        from urllib.parse import urlparse
        segments = [s for s in urlparse(url).path.split("/") if s]
        fallback_title = ""
        if segments:
            stem = segments[-1].rsplit(".", 1)[0]
            fallback_title = stem.replace("_", " ").replace("-", " ").strip()

        return {
            "title":    fallback_title,
            "duration": "",
            "formats": [
                {"label": "Best (auto)", "format_str": "bestvideo+bestaudio/best", "height": None},
                {"label": "Audio only",  "format_str": "bestaudio/best",           "height": 0},
            ],
            "thumbnail": "",
            "source":    "fallback",
            "error":     str(exc),
        }


# ─── WebSocket broadcast ─────────────────────────────────────────────────────

async def broadcast(payload: dict):
    dead: list[WebSocket] = []
    for ws in WS_CLIENTS:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        WS_CLIENTS.discard(ws)


# ─── Download task ────────────────────────────────────────────────────────────

async def run_download(download_id: int, url: str, filename: str, quality: str):
    loop = asyncio.get_running_loop()

    def hook(d: dict):
        if d["status"] == "downloading":
            total      = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
            downloaded = d.get("downloaded_bytes") or 0
            try:
                pct = round(float(downloaded) / float(total) * 100, 2)
            except (ZeroDivisionError, TypeError):
                pct = 0.0
            asyncio.run_coroutine_threadsafe(
                broadcast({"id": download_id, "progress": pct,
                           "speed": d.get("speed"), "eta": d.get("eta")}),
                loop,
            )
            db_update(download_id, pct / 100, "downloading")

        elif d["status"] == "finished":
            asyncio.run_coroutine_threadsafe(
                broadcast({"id": download_id, "progress": 100, "done": True}),
                loop,
            )
            db_update(download_id, 1.0, "completed")

    safe = sanitize_filename(filename) or f"video_{int(time.time())}"
    Path("downloads").mkdir(exist_ok=True)

    ydl_opts = {
        "outtmpl":        f"downloads/{safe}.%(ext)s",
        "progress_hooks": [hook],
        "format":         quality or "bestvideo+bestaudio/best",
        "noplaylist":     True,
        "quiet":          False,
    }

    try:
        await loop.run_in_executor(None, lambda: YoutubeDL(ydl_opts).download([url]))
    except Exception as exc:
        await broadcast({"id": download_id, "error": str(exc)})
        db_update(download_id, 0, "error")


# ─── FastAPI app ──────────────────────────────────────────────────────────────

api = FastAPI(title="Mini IDM")

api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_static = Path(__file__).parent / "static"
if _static.exists():
    api.mount("/static", StaticFiles(directory=str(_static)), name="static")


@api.get("/")
async def root():
    index = Path(__file__).parent / "static" / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return JSONResponse({"message": "Place index.html in the ./static/ folder."})


@api.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    WS_CLIENTS.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        WS_CLIENTS.discard(ws)


# ─── /meta ────────────────────────────────────────────────────────────────────

@api.get("/meta")
async def get_meta(url: str):
    """
    Return title, duration, and available format options for a URL.
    Cached for 5 minutes per URL.
    """
    if not url:
        return JSONResponse(status_code=400, content={"error": "url is required"})

    cached = _META_CACHE.get(url)
    if cached and (time.time() - cached["ts"]) < _META_CACHE_TTL:
        return JSONResponse(cached["data"])

    loop = asyncio.get_running_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(None, _extract_meta_sync, url),
            timeout=30,
        )
    except asyncio.TimeoutError:
        result = {
            "title":    "",
            "duration": "",
            "formats":  [{"label": "Best (auto)", "format_str": "bestvideo+bestaudio/best", "height": None}],
            "thumbnail": "",
            "source":   "timeout",
            "error":    "Metadata extraction timed out",
        }

    _META_CACHE[url] = {"ts": time.time(), "data": result}
    return JSONResponse(result)


# ─── REST endpoints ───────────────────────────────────────────────────────────

@api.post("/download")
async def start_download(data: dict):
    url      = data.get("url", "").strip()
    filename = data.get("filename") or f"video_{int(time.time())}"
    quality  = data.get("quality") or "bestvideo+bestaudio/best"
    title    = data.get("title", "").strip()

    if not url:
        return JSONResponse(status_code=400, content={"error": "url is required"})

    if url.startswith("blob:"):
        return JSONResponse(
            status_code=400,
            content={"error": "Blob URLs are browser-local and cannot be downloaded. "
                               "Send the original watch-page URL instead."},
        )

    download_id = db_insert(url, filename, title)
    asyncio.create_task(run_download(download_id, url, filename, quality))
    return JSONResponse({"id": download_id, "status": "queued"})


@api.get("/list")
def list_downloads():
    return db_list()


@api.delete("/download/{download_id}")
def delete_download(download_id: int):
    if db_delete(download_id):
        return JSONResponse({"deleted": download_id})
    return JSONResponse(status_code=404, content={"error": "Download not found"})


@api.get("/file/{download_id}")
def get_file(download_id: int):
    conn = sqlite3.connect(DB_FILE)
    cur  = conn.cursor()
    cur.execute("SELECT filename, status FROM downloads WHERE id=?", (download_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        return JSONResponse(status_code=404, content={"error": "Download not found"})

    stored_name, status = row
    if status != "completed":
        return JSONResponse(status_code=400, content={"error": "File not ready yet"})

    safe    = sanitize_filename(stored_name)
    matches = glob.glob(f"downloads/{safe}.*") or glob.glob(f"downloads/{stored_name}.*")
    if not matches:
        return JSONResponse(status_code=404, content={"error": "File not found on disk"})

    path = matches[0]
    return FileResponse(path=path, filename=Path(path).name, media_type="application/octet-stream")


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("🚀  Mini IDM backend starting…")
    print("    Web UI  → http://localhost:8000")
    print("    API     → http://localhost:8000")
    print("    WS      → ws://localhost:8000/ws")
    uvicorn.run(api, host="0.0.0.0", port=8000, log_level="info")
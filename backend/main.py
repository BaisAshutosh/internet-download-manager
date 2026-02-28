import asyncio
import glob
import json
import sqlite3
import time
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from yt_dlp import YoutubeDL

DB_FILE = "downloads.db"

# All active WebSocket connections — managed in one place
WS_CLIENTS: set[WebSocket] = set()


# ─── Database ────────────────────────────────────────────────────────────────

def init_db():
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS downloads (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            url        TEXT,
            filename   TEXT,
            status     TEXT,
            progress   REAL,
            created_at TEXT
        )
    """)
    conn.commit()
    conn.close()


init_db()


def db_insert(url: str, filename: str) -> int:
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO downloads (url, filename, status, progress, created_at) "
        "VALUES (?, ?, 'queued', 0, datetime('now'))",
        (url, filename),
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
        "SELECT id, url, filename, status, progress, created_at "
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


# ─── WebSocket broadcast ─────────────────────────────────────────────────────

async def broadcast(payload: dict):
    """Send a JSON message to every connected WebSocket client."""
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
    """Run yt-dlp in a thread-pool executor and stream progress back via WebSocket."""
    loop = asyncio.get_running_loop()

    def hook(d: dict):
        if d["status"] == "downloading":
            total      = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
            downloaded = d.get("downloaded_bytes") or 0          # FIX: was duplicated key
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
        "format":         quality or "best",
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

# Serve static files (web UI lives in ./static/)
_static = Path(__file__).parent / "static"
if _static.exists():
    api.mount("/static", StaticFiles(directory=str(_static)), name="static")


@api.get("/")
async def root():
    index = Path(__file__).parent / "static" / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return JSONResponse({"message": "Place index.html in the ./static/ folder."})


# ─── WebSocket endpoint (replaces the separate websockets server on port 8765) ─

@api.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    WS_CLIENTS.add(ws)
    try:
        # Keep the connection alive; we only push, never pull
        while True:
            await ws.receive_text()          # handles ping/close frames
    except WebSocketDisconnect:
        pass
    finally:
        WS_CLIENTS.discard(ws)


# ─── REST endpoints ───────────────────────────────────────────────────────────

@api.post("/download")
async def start_download(data: dict):
    url      = data.get("url", "").strip()
    filename = data.get("filename") or f"video_{int(time.time())}"
    quality  = data.get("quality") or "best"

    if not url:
        return JSONResponse(status_code=400, content={"error": "url is required"})

    if url.startswith("blob:"):
        return JSONResponse(
            status_code=400,
            content={"error": "Blob URLs are browser-local and cannot be downloaded. "
                               "Send the original watch-page URL instead."},
        )

    download_id = db_insert(url, filename)
    asyncio.create_task(run_download(download_id, url, filename, quality))
    return JSONResponse({"id": download_id, "status": "queued"})


@api.get("/list")
def list_downloads():
    """Return all downloads as a list of JSON objects (not raw tuples)."""
    return db_list()


@api.delete("/download/{download_id}")
def delete_download(download_id: int):
    """Remove a download record from the database."""
    if db_delete(download_id):
        return JSONResponse({"deleted": download_id})
    return JSONResponse(status_code=404, content={"error": "Download not found"})


@api.get("/file/{download_id}")
def get_file(download_id: int, filename: Optional[str] = None):
    """Serve a completed download file to the browser."""
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

    path      = matches[0]
    suggested = filename or Path(path).name
    return FileResponse(path=path, filename=suggested, media_type="application/octet-stream")


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("🚀  Mini IDM backend starting…")
    print("    Web UI  → http://localhost:8000")
    print("    API     → http://localhost:8000")
    print("    WS      → ws://localhost:8000/ws")
    uvicorn.run(api, host="localhost", port=8000, log_level="info")
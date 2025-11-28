import asyncio
import json
import sqlite3
import threading
from pathlib import Path
from typing import Optional
from fastapi import FastAPI
from fastapi.responses import JSONResponse, FileResponse
import glob
import uvicorn
import websockets
from websockets.server import WebSocketServerProtocol
from yt_dlp import YoutubeDL
import time
import streamlit as st

DB_FILE = "downloads.db"
WS_CLIENTS = set()
MAIN_LOOP = None


# -----------------------------
# 1. SQLite Database Setup
# -----------------------------
def init_db():
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT,
            filename TEXT,
            status TEXT,
            progress REAL,
            created_at TEXT
        )
    """
    )
    conn.commit()
    conn.close()


init_db()


def update_db_progress(download_id, progress, status):
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE downloads SET progress=?, status=? WHERE id=?
    """,
        (progress, status, download_id),
    )
    conn.commit()
    conn.close()


def sanitize_filename(name: str) -> str:
    # remove path separators and common forbidden characters for filenames
    if not name:
        return ""
    keep = []
    for ch in name:
        if ch in "\\/<>:?\"|*":
            continue
        keep.append(ch)
    s = "".join(keep).strip()
    # collapse whitespace
    return "_".join(s.split())


# -----------------------------
# 2. WebSocket Server
# -----------------------------
async def ws_handler(websocket: WebSocketServerProtocol):
    WS_CLIENTS.add(websocket)
    try:
        while True:
            await asyncio.sleep(1)
    except:
        pass
    finally:
        WS_CLIENTS.remove(websocket)


async def broadcast(event):
    dead = []
    for ws in WS_CLIENTS:
        try:
            await ws.send(json.dumps(event))
        except:
            dead.append(ws)
    for d in dead:
        WS_CLIENTS.remove(d)


# -----------------------------
# 3. YT-DLP Download with Progress Hook
# -----------------------------
async def run_download_task(download_id, url, filename, quality):
    def hook(d):
        """Progress hook called by yt-dlp."""
        loop = MAIN_LOOP
        if d["status"] == "downloading":
            tb = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
            downloaded = d.get("downloaded_bytes") or d.get("downloaded_bytes") or 0
            try:
                percent = float(downloaded) / float(tb) if tb else 0.0
            except Exception:
                percent = 0.0
            payload = {
                "id": download_id,
                "progress": round(percent * 100, 2),
                "speed": d.get("speed"),
                "eta": d.get("eta"),
            }
            if loop:
                asyncio.run_coroutine_threadsafe(broadcast(payload), loop)
            update_db_progress(download_id, percent, "downloading")

        elif d["status"] == "finished":
            if loop:
                asyncio.run_coroutine_threadsafe(
                    broadcast({"id": download_id, "progress": 100, "done": True}),
                    loop,
                )
            update_db_progress(download_id, 1.0, "completed")

    safe_name = sanitize_filename(filename) or f"video_{int(time.time())}"
    ydl_opts = {
        "outtmpl": f"downloads/{safe_name}.%(ext)s",
        "progress_hooks": [hook],
        "format": quality or "best",  # simplified: use best format directly
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
    }

    Path("downloads").mkdir(exist_ok=True)

    # Run yt-dlp in a thread to avoid blocking; capture exceptions and notify UI
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, lambda: YoutubeDL(ydl_opts).download([url]))
    except Exception as e:
        # notify clients and update DB
        try:
            if MAIN_LOOP:
                asyncio.run_coroutine_threadsafe(
                    broadcast({"id": download_id, "error": str(e)}), MAIN_LOOP
                )
        except Exception:
            pass
        update_db_progress(download_id, 0, "error")
        # re-raise so calling code can see it if needed
        raise


# -----------------------------
# 4. FastAPI Backend for Control
# -----------------------------
api = FastAPI()


@api.post("/download")
async def start_download(data: dict):
    url = data["url"]
    filename = data.get("filename", f"video_{int(time.time())}")
    quality = data.get("quality")

    # Reject blob URLs early with a helpful message — blob: URLs are local to the browser
    # and cannot be accessed by yt-dlp running on the server.
    if isinstance(url, str) and url.startswith("blob:"):
        return JSONResponse(
            status_code=400,
            content={
                "error": "Blob URL not supported. Send the original page or video watch URL (e.g. https://www.youtube.com/watch?v=...) instead.",
            },
        )
    # Insert into DB
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO downloads (url, filename, status, progress, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        (url, filename, "queued", 0),
    )
    download_id = cur.lastrowid
    conn.commit()
    conn.close()

    asyncio.create_task(run_download_task(download_id, url, filename, quality))
    return JSONResponse({"id": download_id, "status": "started"})


@api.get("/list")
def list_downloads():
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute("SELECT * FROM downloads ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    return rows


@api.get("/file/{download_id}")
def get_file(download_id: int, filename: Optional[str] = None):
    """Serve a completed download file so the browser can save it.

    If `filename` is provided it will be suggested to the browser via
    the Content-Disposition header. The browser will then prompt the user
    where to save the file.
    """
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute("SELECT filename, status FROM downloads WHERE id=?", (download_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        return JSONResponse(status_code=404, content={"error": "Download not found"})

    stored_name, status = row
    if status != "completed":
        return JSONResponse(status_code=400, content={"error": "File not ready for download"})

    safe = sanitize_filename(stored_name)
    # find the file on disk (matches downloads/<safe>.*)
    matches = glob.glob(f"downloads/{safe}.*")
    if not matches:
        # try raw stored name as fallback
        matches = glob.glob(f"downloads/{stored_name}.*")

    if not matches:
        return JSONResponse(status_code=404, content={"error": "Downloaded file not found on server"})

    file_path = matches[0]
    suggested = filename or Path(file_path).name
    return FileResponse(path=file_path, filename=suggested, media_type="application/octet-stream")


# -----------------------------
# 5. Streamlit UI (control panel)
# -----------------------------
def run_streamlit():
    st.title("IDM-like Python Downloader")

    url = st.text_input("Video URL")
    filename = st.text_input("Filename (optional)")
    quality = st.text_input("Quality format (yt-dlp syntax)", "best")

    if st.button("Start Download"):
        import requests

        r = requests.post(
            "http://localhost:8000/download",
            json={"url": url, "filename": filename, "quality": quality},
        )
        st.success(f"Started: {r.json()}")

    st.subheader("Active Downloads")
    import requests

    rows = requests.get("http://localhost:8000/list").json()
    st.table(rows)


# -----------------------------
# 6. Websocket + API + Streamlit
# -----------------------------
async def main():
    global MAIN_LOOP
    # capture the running asyncio loop so threads (yt-dlp hooks) can post messages back
    MAIN_LOOP = asyncio.get_running_loop()
    ws_server = websockets.serve(ws_handler, "0.0.0.0", 8765)

    server_thread = threading.Thread(
        target=lambda: uvicorn.run(api, host="0.0.0.0", port=8000), daemon=True
    )
    server_thread.start()

    streamlit_thread = threading.Thread(target=lambda: run_streamlit(), daemon=True)
    streamlit_thread.start()

    await ws_server
    await asyncio.Future()  # keep alive indefinitely


if __name__ == "__main__":
    asyncio.run(main())

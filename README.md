# Internet Download Manager (Mini IDM)

A local-first video downloader with:
- FastAPI backend
- Web UI for managing downloads
- Chrome extension that detects stream URLs and sends them to the backend
- yt-dlp for actual downloading
- SQLite for persistent download history

## Current Features

- Start downloads from:
  - Web UI (`http://localhost:8000`)
  - Chrome extension popup
- Real-time progress updates in Web UI via WebSocket (`ws://localhost:8000/ws`)
- Pause, resume, and cancel active downloads
- Metadata probing (`/meta`) for title, duration, and quality options
- Completed file retrieval with `/file/{download_id}`
- Persistent history in `downloads/downloads.db`

## Project Structure

```text
internet-download-manager/
  backend/
    main.py                 # FastAPI app + downloader logic
    requirements.txt
    static/index.html       # Web UI
    downloads/              # Downloaded files + SQLite DB
    Dockerfile
    docker-compose.yml
  chrome-extension/
    manifest.json
    content.js              # Detects media URLs from pages
    background.js           # Stores detected URLs in extension storage
    popup.html
    popup.js                # Sends URL to backend and requests metadata
  QUICKSTART.md
  ARCHITECTURE.md
```

## Run Locally

```powershell
cd backend
pip install -r requirements.txt
python main.py
```

You can also run the app inside Docker:

```powershell
cd backend
docker compose up --build
```

Then open `http://localhost:8000`.  The container includes `ffmpeg` and `nodejs` which yt-dlp uses for certain formats.

## Main API Endpoints

- `GET /` - Web UI
- `GET /meta?url=...` - Fetch media metadata and quality options
- `POST /download` - Queue a download
- `POST /download/{id}/pause`
- `POST /download/{id}/resume`
- `POST /download/{id}/cancel`
- `GET /list` - Download history
- `DELETE /download/{id}` - Remove history row
- `GET /file/{id}` - Download completed file
- `WS /ws` - Real-time progress events

## Notes

- `blob:` URLs are rejected by backend by design. Send the original page URL instead.
- If a site requires JS runtime extraction, backend uses yt-dlp with Node/Deno runtimes enabled.

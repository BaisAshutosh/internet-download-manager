# Real-Time IDM Architecture Guide

## Overview
Your IDM now has a complete **real-time communication system** using **WebSocket** connections, similar to the official IDM. The system components communicate efficiently for live progress updates.

```
┌─────────────────────────────────────────────────────────────┐
│                      System Architecture                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Chrome Extension         Web UI           Backend Server    │
│  (popup.js)              (index.html)      (main.py)         │
│       │                       │                 │            │
│       │ HTTP Download         │                 │            │
│       ├──────────────────────>│ HTTP /download  │            │
│       │         Request       ├────────────────>│            │
│       │                       │                 │            │
│       │                ┌───────────────────┐    │            │
│       │                │  SQLite Database  │<───┤            │
│       │                └───────────────────┘    │            │
│       │                                         │            │
│       │  WebSocket ws://localhost:8765         │            │
│       ├─────────────────────────────────────────┤            │
│       │                                         │            │
│       │     Real-Time Progress Updates          │            │
│       │<─────────────────────────────────────────┤            │
│       │                                         │            │
│       │       Web UI also connects via WS       │            │
│       │                (HTTP REST for list)     │            │
│       └─────────────────────────────────────────┘            │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Backend Server (`backend/main.py`)
**Ports:**
- **8000**: FastAPI REST API + Web UI serving
- **8765**: WebSocket server for real-time updates

**Features:**
- Full set of REST endpoints for download management and metadata
- SQLite database for persistent storage
- WebSocket broadcasting for live progress
- yt-dlp integration for downloading (supports pause/resume/cancel)

**Key Functions:**
- `POST /meta?url=…` – fetch title, duration and format options
- `POST /download` - Start a new download
- `POST /download/{id}/pause` - Pause an active download
- `POST /download/{id}/resume` - Resume a paused download
- `POST /download/{id}/cancel` - Cancel an in-flight or queued download
- `DELETE /download/{id}` – Remove history entry
- `GET /list` - Get all downloads (HTTP REST)
- `GET /` - Serve web UI
- `ws://localhost:8765` - WebSocket for real-time updates

### 2. Web UI (`backend/static/index.html`)
**Access:** http://localhost:8000

**Features:**
- Beautiful, responsive UI
- Real-time WebSocket connection
- Live progress bars
- Download history
- Direct file download button

**Communication Flow:**
1. Opens WebSocket to `ws://localhost:8765`
2. Submits downloads via HTTP POST to `/download`
3. Receives live updates through WebSocket
4. Downloads completed files via HTTP GET

### 3. Chrome Extension

#### Content Script (`content.js`)
- Scans web pages for video URLs
- Detects streams from `<video>` tags, HLS, DASH, etc.
- Sends detected URLs to background script

#### Background Script (`background.js`)
- Stores detected URLs in extension storage
- Communicates with popup

#### Popup UI (`popup.html` + `popup.js`)
- Shows detected video URLs
- Sends downloads to backend
- **NEW**: Shows real-time download progress via WebSocket
- Displays last 5 active downloads with progress bars

## Real-Time Communication Flow

### Standard Download Process
```
1. Extension detects URL on webpage
   ↓
2. User clicks "Send to Downloader" in popup
   ↓
3. Popup sends HTTP POST request
   POST /download {url, filename, quality}
   ↓
4. Backend creates database entry (ID received)
   ↓
5. **WebSocket connects to ws://localhost:8765**
   ↓
6. Backend starts yt-dlp download in thread
   ↓
7. yt-dlp progress hook fires
   ↓
8. Hook broadcasts update via WebSocket to ALL connected clients
   {id: 123, progress: 45.6, speed: 1200000, eta: 120}
   ↓
9. Web UI + Extension Popup receive update in real-time
   ↓
10. UI updates progress bar immediately
    ↓
11. Download finishes → progress = 100, status = "completed"
```

### Why WebSocket?

| Feature | HTTP Polling | HTTP Long-Poll | WebSocket |
|---------|--|--|--|
| **Real-time** | ❌ Delayed | ⚠️ Delayed | ✅ Instant |
| **Overhead** | ❌ High | ⚠️ High | ✅ Low |
| **Connection** | One-time | One-time | Persistent |
| **Bandwidth** | More requests | Fewer requests | Minimal |
| **Implemented** | ✅ Fallback | ❌ No | ✅ Primary |

## Dependencies

The backend requires Python 3.10+ (the Dockerfile uses **Python 3.13‑slim**) and a handful of helper binaries when running in a container. The Python packages are listed in `backend/requirements.txt`:

```text
fastapi
uvicorn
yt-dlp
python-multipart
websockets
```

System libraries installed by the `Dockerfile` include:

* `ffmpeg` – used by **yt-dlp** to merge video/audio streams.
* `nodejs` – required for YouTube’s JS‑based extraction logic.
* `curl` – used by the built‑in healthcheck.

(If you run the backend locally you only need Python and the packages above; the helper binaries are only necessary inside Docker.)

A `docker-compose.yml` file is provided for container deployments. It exposes port **8000**, mounts `./downloads` for persistence, and restricts resources to 1 GiB of memory.

## Setup Instructions

### 1. Install Backend Dependencies
```powershell
cd backend
pip install -r requirements.txt
```

### 2. Start the Backend
You can run the Python server directly:
```powershell
python start.py
```

Or, if you prefer containerization, build and start the service with Docker Compose:
```powershell
cd backend
docker compose up --build
```

Either method will log the same startup message:
```
🚀 Backend started!
   Web UI: http://localhost:8000
   API: http://localhost:8000
   WebSocket: ws://localhost:8765
```

### 3. Access Web UI
Open browser: **http://localhost:8000**

### 4. Load Chrome Extension
1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select your `chrome-extension` folder

### 5. Test Real-Time Updates
1. Go to any website with video (YouTube, Vimeo, etc.)
2. Click extension → detect streams
3. Send to downloader
4. Open web UI at http://localhost:8000
5. Watch both update in **real-time** as download progresses!

## WebSocket Message Format

### Progress Update (from backend → clients)
```json
{
  "id": 123,
  "progress": 45.6,
  "speed": 1200000,
  "eta": 120
}
```

### Completion Message
```json
{
  "id": 123,
  "progress": 100,
  "done": true
}
```

### Error Message
```json
{
  "id": 123,
  "error": "Connection timeout"
}
```

## Key Differences from Official IDM

| Aspect | Official IDM | Your IDM |
|--------|--|--|
| **Web UI** | Desktop app | Modern web UI (accessible everywhere) |
| **Real-time** | ✅ Built-in | ✅ WebSocket-based |
| **Browser Integration** | ✅ Native | ✅ Chrome Extension |
| **Progress** | ✅ Live bars | ✅ Live bars + WebSocket updates |
| **Download** | ✅ Multi-threaded | ✅ yt-dlp based |
| **Cross-platform** | Platform-specific | ✅ Works on Windows/Mac/Linux |

## Configuration

### Change Backend Port
Edit `start.py`:
```python
uvicorn.run("main:api", host="0.0.0.0", port=8001)  # Change 8000 to any port
```

Then update:
- Extension popup: `backendHost = "localhost:8001"`
- Web UI: Change API_BASE in HTML
- Extension content: Update endpoint

### Change WebSocket Port
Edit `main.py`:
```python
ws_server = websockets.serve(ws_handler, "0.0.0.0", 9999)  # Change 8765
```

Then update:
- Web UI: Change `WS_URL = "ws://localhost:9999"`
- Extension popup: Change `wsUrl = "ws://localhost:9999"`

### Change Download Directory
Edit `main.py`:
```python
Path("downloads").mkdir(exist_ok=True)  # Change "downloads" to desired path
```

## Troubleshooting

### WebSocket Connection Fails
**Check:**
1. Backend is running: `python start.py`
2. Port 8765 is accessible
3. Firewall allows WebSocket connections

### Extension not detecting URLs
**Solution:**
1. Refresh the webpage
2. Check content.js console (right-click → Inspect)
3. Look for "[Mini-IDM]" log messages

### Downloads not starting
**Check:**
1. yt-dlp is installed: `pip install yt-dlp`
2. Backend is running
3. URL is valid and publicly accessible
4. Check `downloads/` folder permissions

### Progress not updating
**Ensure:**
1. WebSocket is connected (check web UI status indicator)
2. Backend WebSocket is running on port 8765
3. No firewall blocking WebSocket

## Database Schema

SQLite stores all downloads:
```sql
CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT,
    filename TEXT,
    status TEXT,           -- 'queued' | 'downloading' | 'completed' | 'error'
    progress REAL,         -- 0.0 to 1.0
    created_at TEXT        -- ISO timestamp
)
```

## Advanced: Running Behind Proxy

If deploying behind a reverse proxy (nginx, Apache):
1. Configure WebSocket support (important!)
2. Update connections in code to use proxy URL
3. Enable CORS headers

Example nginx config:
```nginx
location / {
    proxy_pass http://localhost:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

location /ws {
    proxy_pass http://localhost:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Performance Notes

- **WebSocket overhead**: ~2KB per progress update (vs ~5KB per HTTP request)
- **Update frequency**: Progress updates ~1-2/second (configurable)
- **Concurrent downloads**: Scales well with WebSocket (one connection per client)
- **Memory**: All active downloads in memory, persisted to SQLite

---

**Built with:** FastAPI + WebSocket + yt-dlp + SQLite + Chrome Extension

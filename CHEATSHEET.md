# Quick Reference Card

## 🚀 Running Your IDM

### Start Backend (One Command)
```powershell
python backend/start.py
```

**Ports:**
- 🌐 Web UI: http://localhost:8000
- 📡 API: http://localhost:8000/download
- 🔌 WebSocket: ws://localhost:8765

---

## 💻 Three Ways to Use

### 1️⃣ Web UI (Modern Browser Interface)
```
Open: http://localhost:8000
- Start downloads via form
- See real-time progress
- Download completed files
- Modern design
```

### 2️⃣ Chrome Extension
```
- Detects video URLs on websites
- One-click download start
- Real-time progress in popup
- Send multiple downloads
```

### 3️⃣ API (Programmatic)
```bash
# Start download
curl -X POST http://localhost:8000/download \
  -H "Content-Type: application/json" \
  -d '{"url":"https://...", "filename":"video", "quality":"best"}'

# Get all downloads
curl http://localhost:8000/list

# Download file
curl http://localhost:8000/file/123
```

---

## 📡 What's Real-Time Now

✅ All clients see updates together
✅ Progress bars update instantly
✅ Status changes broadcast immediately
✅ No page refresh needed
✅ Works across multiple browser tabs
✅ Extension and web UI stay in sync

---

## 🎯 Typical Workflow

**Via Web UI:**
```
1. Open http://localhost:8000
2. Paste URL
3. (Optional) Enter filename
4. Click "Start Download"
5. Watch progress live
6. Click "Download" when done
```

**Via Extension:**
```
1. Visit website with video
2. Click extension icon
3. Select detected stream
4. Click "Send to Downloader"
5. Progress appears in popup
```

---

## 🔍 Folder Structure

```
internet-download-manager/
├── backend/
│   ├── main.py              (FastAPI + WebSocket server)
│   ├── start.py             (Entry point)
│   ├── requirements.txt      (Dependencies)
│   ├── static/
│   │   └── index.html       (Web UI)
│   └── downloads/           (Downloaded files)
├── chrome-extension/
│   ├── manifest.json
│   ├── popup.html           (Extension popup)
│   ├── popup.js             (Real-time WebSocket)
│   ├── content.js           (URL detection)
│   ├── background.js        (Storage)
│   └── icons/
└── QUICKSTART.md            (Setup guide)
```

---

## ⚙️ Configuration (Defaults)

| Setting | Value | Where |
|---------|-------|-------|
| API Port | 8000 | `backend/start.py` |
| WebSocket Port | 8765 | `backend/main.py` |
| Download Folder | `backend/downloads/` | `backend/main.py` |
| Database | `backend/downloads.db` | `backend/main.py` |

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| "Port 8000 already in use" | Change port in `start.py`, update URLs |
| "WebSocket disconnected" | Check firewall, restart backend |
| "Can't reach backend" | Ensure `python start.py` is running |
| "No videos detected" | Refresh webpage, wait 2 seconds |
| "Download fails" | Check URL is valid and public |

---

## 📊 Monitoring

### Check Running Backend
```powershell
# See if port 8000 is listening
netstat -an | findstr 8000
```

### View SQLite Database
```powershell
# Install DB viewer or use Python
sqlite3 backend/downloads.db
# Then: SELECT * FROM downloads;
```

### Check Recent Downloads
```powershell
# List files
ls backend/downloads/
```

---

## 🔌 WebSocket Events

### What Your UI Receives

```json
// Progress update
{"id": 123, "progress": 45.6, "speed": 1200000, "eta": 120}

// Completion
{"id": 123, "progress": 100, "done": true}

// Error
{"id": 123, "error": "Connection timeout"}
```

---

## 📱 Access From Other Devices

### Local Network
```
Replace localhost with your PC IP:
- Web UI: http://192.168.1.100:8000
- WebSocket: ws://192.168.1.100:8765
```

### Behind Router
```
1. Port forward 8000 to your PC
2. Access: http://your-ip-address:8000
3. WebSocket: ws://your-ip-address:8765
```

---

## 🚪 Stop Backend

```powershell
# Break the running process
Ctrl + C
```

---

## 📈 Performance Tips

- ✅ Close unused browser tabs
- ✅ Limit concurrent downloads (4-8 recommended)
- ✅ Use good internet connection
- ✅ Keep downloads folder on fast drive

---

## 🔐 Security Notes

- ⚠️ CORS is open to all origins (for convenience)
- ⚠️ Restrict in production with proper origins
- ⚠️ Don't expose to internet without authentication
- ✅ Only download from trusted sources

---

## 📞 API Endpoints Cheat Sheet

```
POST /download
- Start new download
- Body: {url, filename?, quality?}
- Returns: {id, status}

GET /list
- Get all downloads
- Returns: [[id, url, filename, status, progress, created_at], ...]

GET /file/{download_id}
- Download completed file
- Returns: File download

GET /
- Web UI
- Returns: HTML page

WS /
- Real-time updates (WebSocket)
- Port: 8765
```

---

## ✨ What Makes This Special

| Feature | IDM | Official IDM |
|---------|-----|--|
| **Real-time** | ✅ WebSocket | ✅ Similar |
| **Browser** | ✅ Chrome ext | ✅ Similar |
| **Web UI** | ✅ Beautiful | ✅ Similar |
| **Progress** | ✅ Live | ✅ Similar |
| **Multi-tabs** | ✅ Sync | ✅ Similar |
| **Cross-platform** | ✅ Windows/Mac/Linux | ❌ Windows only |

---

## 📚 More Info

👉 See `QUICKSTART.md` for setup
👉 See `ARCHITECTURE.md` for deep dive
👉 See `IMPLEMENTATION_SUMMARY.md` for changes

---

Happy downloading! 📥

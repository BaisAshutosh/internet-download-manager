# Quick Start Guide

## 1️⃣ Install Dependencies

```powershell
cd backend
pip install -r requirements.txt
```

## 2️⃣ Start the Backend

```powershell
python start.py
```

You should see:
```
🚀 Backend started!
   Web UI: http://localhost:8000
   API: http://localhost:8000
   WebSocket: ws://localhost:8765
```

## 3️⃣ Open Web UI

Open your browser and go to: **http://localhost:8000**

You'll see a modern interface with a form to start downloads and real-time progress tracking.

## 4️⃣ Setup Chrome Extension (Optional)

1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select your `chrome-extension` folder
5. Visit any video site (YouTube, etc.)
6. Click the extension icon to see detected videos
7. Click "Send to Downloader" to send to your backend

## ✨ What's Real-Time Now?

### Web UI (http://localhost:8000)
- ✅ Live progress bars
- ✅ Real-time status updates
- ✅ Download history
- ✅ Direct file download

### Chrome Extension
- ✅ Shows last 5 active downloads
- ✅ Real-time progress for each
- ✅ Connection status indicator
- ✅ One-click download start

### Backend
- ✅ WebSocket server for live updates
- ✅ FastAPI REST API
- ✅ SQLite persistent storage
- ✅ yt-dlp downloader

## 📝 How It Works

```
1. Start download via Web UI or Extension
   ↓
2. Backend creates database entry
   ↓
3. WebSocket broadcasts progress live
   ↓
4. UI updates in real-time (no page refresh needed!)
   ↓
5. Download completes → Download button appears
```

## 🔧 Customization

### Change Ports
Edit `start.py` and `main.py` to change 8000 and 8765.

### Change Download Folder
Edit `main.py` line with `Path("downloads")`

### Add More Formats
Edit quality options in Web UI form

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Backend won't start | Check if port 8000 is in use |
| No real-time updates | Check if WebSocket is connected (green indicator) |
| Extension not detecting | Refresh webpage, check browser console |
| Downloads not starting | Ensure the URL is valid and public |

## 📚 More Info

See `ARCHITECTURE.md` for detailed system design, async flow, and advanced features.

Happy downloading! 📥

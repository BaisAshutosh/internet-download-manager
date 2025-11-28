# ui.py
import streamlit as st
import requests, threading, time, json, websocket

API = "http://127.0.0.1:8000"

st.title("Mini IDM - Controller")

if st.button("Refresh task list"):
    pass

# fetch tasks
try:
    r = requests.get(API + "/tasks")
    tasks = r.json()
except Exception as e:
    st.error("Failed to fetch tasks: " + str(e))
    tasks = []

for t in tasks:
    st.markdown(f"**{t['filename']}** — {t['status']}")
    st.progress(0, key=t['id'] + "_p")
    st.write(f"Downloaded: {t['downloaded']} / {t['total']}")
    cols = st.columns(3)
    if cols[0].button("Start", key=t['id'] + "_start"):
        requests.post(f"{API}/tasks/{t['id']}/start")
    if cols[1].button("Pause", key=t['id'] + "_pause"):
        requests.post(f"{API}/tasks/{t['id']}/pause")
    if cols[2].button("Cancel", key=t['id'] + "_cancel"):
        requests.post(f"{API}/tasks/{t['id']}/cancel")

st.write("Realtime updates below (connect to websocket)...")

# open a websocket in background to update progress
if 'ws_thread' not in st.session_state:
    st.session_state.ws_thread = None
    st.session_state.latest = {}

def on_message(ws, message):
    data = json.loads(message)
    st.session_state.latest[data['id']] = data

def run_ws():
    ws = websocket.WebSocketApp("ws://127.0.0.1:8000/ws",
                                on_message=lambda ws,msg: on_message(ws,msg),
                                on_error=lambda ws,err: print("ws err", err))
    ws.run_forever()

if st.session_state.ws_thread is None:
    t = threading.Thread(target=run_ws, daemon=True)
    st.session_state.ws_thread = t
    t.start()

# show latest
for tid, info in st.session_state.latest.items():
    st.write(info)
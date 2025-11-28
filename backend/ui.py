import streamlit as st
import requests

API = "http://localhost:8000"

st.title("Mini IDM - Controller")

st.markdown("### Start a new download")
url = st.text_input("Video or stream URL")
filename = st.text_input("Suggested filename (optional)")
quality = st.text_input("Quality (yt-dlp format)", "best")

if st.button("Start Download"):
    try:
        r = requests.post(f"{API}/download", json={"url": url, "filename": filename, "quality": quality})
        st.success(f"Started: {r.json()}")
    except Exception as e:
        st.error(f"Failed to start download: {e}")

st.markdown("### Recent Downloads")
try:
    r = requests.get(f"{API}/list")
    rows = r.json()
except Exception as e:
    st.error("Failed to fetch downloads: " + str(e))
    rows = []

# rows are returned as tuples (id, url, filename, status, progress, created_at)
for row in rows:
    did, url, fname, status, progress, created_at = row
    st.markdown(f"**ID {did} — {fname}**")
    st.write(f"URL: {url}")
    st.write(f"Status: {status} — Progress: {round(progress*100 if progress else 0,2)}%")
    if status == "completed":
        file_url = f"{API}/file/{did}"
        st.markdown(f"[Download file in browser]({file_url})")
    st.write("---")
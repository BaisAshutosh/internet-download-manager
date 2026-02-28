# ── Stage: runtime ────────────────────────────────────────────────────────────
FROM python:3.13-slim

# Prevents Python from writing .pyc files and buffers stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ── System dependencies ────────────────────────────────────────────────────────
# ffmpeg        — required by yt-dlp to merge separate video+audio streams
# nodejs        — required by yt-dlp for YouTube JS-based format extraction
# curl          — used by the healthcheck below
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        nodejs \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── Working directory ──────────────────────────────────────────────────────────
WORKDIR /app

# ── Python dependencies ────────────────────────────────────────────────────────
# Copy requirements first so Docker can cache this layer independently
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Application code ───────────────────────────────────────────────────────────
COPY main.py .

# Web UI — index.html lives in ./static/ so FastAPI can serve it at GET /
RUN mkdir -p static
COPY static/index.html static/index.html

# downloads/ is where yt-dlp writes files.
# It is declared as a VOLUME so Docker (or docker-compose) can mount it
# to a host directory, meaning files survive container restarts and rebuilds.
RUN mkdir -p downloads
VOLUME ["/app/downloads"]

# ── Ports ──────────────────────────────────────────────────────────────────────
EXPOSE 8000

# ── Healthcheck ───────────────────────────────────────────────────────────────
# Docker will mark the container unhealthy if the API stops responding.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/ || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
CMD ["python", "main.py"]
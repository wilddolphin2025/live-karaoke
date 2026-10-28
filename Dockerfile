FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu128 -r requirements.txt
COPY asr/ asr/
# Git short SHA of the build, reported by GET /v1/info. Last so code-only rebuilds stay cached.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    HF_HOME=/models
EXPOSE 8000
# One Uvicorn process per pod: Kubernetes does the scaling. Drain up to 50s on SIGTERM.
CMD ["uvicorn", "asr.api:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "50"]

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu128 -r requirements.txt
# Vocal removal (separator pod): Demucs 4.0.1 + its pure-Python deps, pinned, --no-deps so pip never
# touches the CUDA torch above (~3 MB layer). Weights (~400 MB) live in the host cache (TORCH_HOME=/models/torch).
RUN pip install --no-cache-dir --no-deps demucs==4.0.1 dora-search==0.1.13 julius==0.2.7 lameenc==1.9.0 \
    openunmix==1.3.0 retrying==1.4.2 submitit==1.5.4 treetable==0.2.6
COPY asr/ asr/
# Git short SHA of the build, reported by GET /v1/info. Last so code-only rebuilds stay cached.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    HF_HOME=/models
EXPOSE 8000
# One Uvicorn process per pod: Kubernetes does the scaling. Drain up to 50s on SIGTERM.
CMD ["uvicorn", "asr.api:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "50"]

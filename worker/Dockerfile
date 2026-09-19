# syntax=docker/dockerfile:1

# 1stSeen agent API — Cloud Run image.
#
# Two stages. The builder owns the compiler toolchain and produces a virtualenv;
# the runtime stage starts from the same clean base and copies only that venv, so
# gcc, headers, and build caches never reach the published image.
#
# Pinned by digest, not tag: a tag is mutable, and "the image we tested" has to
# mean one exact set of bytes. Refresh deliberately with
#   docker pull python:3.12-slim && docker inspect --format='{{index .RepoDigests 0}}' python:3.12-slim
ARG BASE_IMAGE=python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# ---------------------------------------------------------------- build stage
FROM ${BASE_IMAGE} AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

# Only a few dependencies still ship sdists that need a compiler; everything else
# resolves to a wheel. None of this survives into the runtime stage.
RUN apt-get update \
 && apt-get install --no-install-recommends -y build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app/worker

# Dependency metadata first so a source-only edit reuses the dependency layer.
COPY worker/pyproject.toml ./pyproject.toml
COPY worker/src ./src

RUN pip install --no-cache-dir -e ".[api]"

# -------------------------------------------------------------- runtime stage
FROM ${BASE_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8080

# Fixed uid so a Cloud Run/Kubernetes runAsUser assertion has something stable to
# match, and so file ownership is predictable under a read-only root filesystem.
RUN groupadd --gid 10001 firstseen \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin firstseen

COPY --from=builder --chown=root:root /opt/venv /opt/venv
# The venv holds an editable install, so the sources have to live at the same
# path they did at build time. Owned by root and only readable by the runtime
# user: the process never needs to write to its own code.
COPY --from=builder --chown=root:root /app/worker /app/worker

WORKDIR /app/worker
USER 10001:10001

EXPOSE 8080

# No secret, no database, no auth — see agent_api.RecruitingAgentApi.__call__.
# Cloud Run runs its own probes; this HEALTHCHECK is for local `docker run`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/health', timeout=2).status==200 else 1)"

# One worker on purpose. `RecruitingAgent.stream()` is a synchronous generator
# iterated on the event loop, so a second process would not make a single
# investigation faster, and two copies of litellm + supabase do not fit 512Mi
# with headroom. See docs/deployment.md, "Concurrency and the blocking stream".
#
# Shell form so ${PORT} expands: Cloud Run injects it and may not use 8080.
CMD exec uvicorn firstseen.agent_api:app \
      --host 0.0.0.0 \
      --port ${PORT:-8080} \
      --workers 1 \
      --timeout-keep-alive 65 \
      --no-server-header \
      --log-level info

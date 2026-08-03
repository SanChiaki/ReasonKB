ARG UV_VERSION=0.12.1
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-bookworm

ARG REASONKB_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$REASONKB_GIT_SHA

WORKDIR /app

COPY --from=uv /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON=/usr/bin/python3 \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
COPY web/patches ./web/patches
RUN pnpm -C web install --frozen-lockfile

COPY . .
RUN find docker/entrypoints -type f -name "*.sh" -exec sed -i 's/\r$//' {} + \
  && chmod +x docker/entrypoints/*.sh
RUN pnpm -C web build

EXPOSE 3000 3002 8001

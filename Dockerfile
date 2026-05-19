FROM node:22-bookworm

ARG REASONKB_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$REASONKB_GIT_SHA

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY services/requirements.txt ./services/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --upgrade pip \
  && /opt/venv/bin/pip install -r services/requirements.txt

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN pnpm -C web install --frozen-lockfile

COPY . .
RUN pnpm -C web build

EXPOSE 3000 8001

#!/usr/bin/env sh
set -eu

ACR_IMAGE="${ACR_IMAGE:-crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com/reasonkb/reasonkb}"
REASONKB_TAG="${REASONKB_TAG:-latest}"
GOTENBERG_TAG="${GOTENBERG_TAG:-gotenberg-8}"
PLATFORM="${PLATFORM:-linux/amd64}"

cd "$(dirname "$0")/.."

docker buildx build \
  --platform "$PLATFORM" \
  -f docker/Dockerfile \
  -t "$ACR_IMAGE:$REASONKB_TAG" \
  --push \
  .

docker buildx build \
  --platform "$PLATFORM" \
  -f docker/Dockerfile.gotenberg \
  -t "$ACR_IMAGE:$GOTENBERG_TAG" \
  --push \
  .

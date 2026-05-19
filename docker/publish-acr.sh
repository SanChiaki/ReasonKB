#!/usr/bin/env sh
set -eu

ACR_IMAGE="${ACR_IMAGE:-crpi-95tja6y49h58rco0.cn-shenzhen.personal.cr.aliyuncs.com/reasonkb/reasonkb}"
REASONKB_TAG="${REASONKB_TAG:-latest}"
GOTENBERG_TAG="${GOTENBERG_TAG:-gotenberg-8}"
PLATFORM="${PLATFORM:-linux/amd64}"

cd "$(dirname "$0")/.."

GIT_SHA="$(git rev-parse HEAD)"

docker buildx build \
  --platform "$PLATFORM" \
  -f docker/Dockerfile \
  --build-arg "REASONKB_GIT_SHA=$GIT_SHA" \
  -t "$ACR_IMAGE:$REASONKB_TAG" \
  --push \
  .

docker buildx build \
  --platform "$PLATFORM" \
  -f docker/Dockerfile.gotenberg \
  -t "$ACR_IMAGE:$GOTENBERG_TAG" \
  --push \
  .

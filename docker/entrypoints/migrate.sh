set -eu

python -m services.common.source_credentials "${REASONKB_MASTER_KEY_FILE:?REASONKB_MASTER_KEY_FILE is required}"
pnpm -C web db:migrate

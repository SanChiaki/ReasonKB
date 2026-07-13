set -eu

python -m services.common.source_credentials "${REASONKB_MASTER_KEY_FILE:?REASONKB_MASTER_KEY_FILE is required}"
exec python -m services.index_worker.worker

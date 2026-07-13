set -eu

python -m services.common.source_credentials "${REASONKB_MASTER_KEY_FILE:?REASONKB_MASTER_KEY_FILE is required}"
DB_PATH="${APP_DB_PATH:-/app/var/app.db}"
until [ -f "$DB_PATH" ]; do
  echo "Waiting for migrated SQLite database: $DB_PATH"
  sleep 1
done

exec python -m services.source_worker.worker

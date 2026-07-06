# SMB Remote Corpus Design

## Context

ReasonKB currently treats the project corpus as a local directory. The directory watcher scans `PROJECTS_ROOT`, stores each document's local `storage_path`, and the index worker passes that path to PageIndex, PyPDF2, Gotenberg, Markdown/Text readers, or image extraction. This works for bind-mounted local folders, but it does not let a container connect to a Windows/SMB share with a username and password without granting mount privileges.

The first SMB version should avoid container `CAP_SYS_ADMIN`, avoid host-level SMB mounts, and avoid mirroring the full share into local storage. It should connect to SMB as an application client, scan only remote metadata during normal polling, and fetch a single file only when an index job needs that file.

## Goals

- Support a Windows/SMB share as the project corpus source.
- Keep the container unprivileged; do not use `mount.cifs` or Docker `cap_add: SYS_ADMIN`.
- Do not full-sync SMB files into a local mirror.
- Detect normal changes from remote metadata using `mtime + size`.
- Fetch a remote file on demand during indexing, then pass a temporary local path into the existing indexing pipeline.
- Extend `docker/install.sh` so first-time release installs can configure SMB source settings and credentials.
- Record Settings UI credential management as a follow-up task, not part of the first implementation.

## Non-Goals

- No SMB mounting inside the container.
- No host-level SMB mount automation.
- No multi-source corpus management in the first version.
- No Settings UI for adding, editing, or rotating SMB credentials in the first version.
- No strong content-hash change detection during metadata scans.
- No attempt to keep indexing consistent if a remote file changes while it is being downloaded; the next metadata scan will schedule another index job if `mtime` or `size` changed.

## Recommended Approach

Use a remote corpus source module with a small interface:

```text
list_files() -> remote file metadata
fetch_file(remote file, local destination) -> local file
```

The first adapter is SMB-backed. A later local-directory adapter can reuse the same interface if the existing directory watcher is migrated, but the first implementation can keep local scanning unchanged and route only `REASONKB_CORPUS_SOURCE=smb` through the SMB adapter.

This approach keeps SMB protocol complexity in one module. Directory sync only needs metadata, and indexing only needs a temporary local path.

## Configuration

First version configuration is environment/secret-file driven:

```ini
REASONKB_CORPUS_SOURCE=smb
REASONKB_SMB_HOST=fileserver.example.local
REASONKB_SMB_SHARE=Projects
REASONKB_SMB_BASE_PATH=
REASONKB_SMB_USERNAME_FILE=./secrets/smb_username
REASONKB_SMB_PASSWORD_FILE=./secrets/smb_password
REASONKB_SMB_DOMAIN=
REASONKB_SMB_PORT=445
REASONKB_SMB_AUTH_PROTOCOL=ntlm
REASONKB_REMOTE_CACHE_ROOT=/app/.reasonkb/var/remote-cache
```

Notes:

- `REASONKB_CORPUS_SOURCE=local` or unset preserves existing local directory behavior.
- `REASONKB_SMB_BASE_PATH` lets an administrator point at a subfolder inside a share without creating another SMB share.
- Username and password should be read from files rather than direct environment values so the password does not appear in `docker inspect` output.
- Release compose should mount `./secrets` read-only into containers that need SMB access.
- SMB credentials are not written to SQLite in the first version.
- In SMB mode, release compose should not require `${REASONKB_PROJECTS_ROOT}` to exist or be bind-mounted for `directory-watcher` and `index-worker`. Those containers need the shared app var volume and the read-only secret files; the web container can keep the host browse mount only for local-source settings compatibility.

## Installer Flow

`docker/install.sh` should ask whether the corpus is local or SMB during interactive installs.

For local corpus, it preserves the current flow:

```text
Project corpus directory
Host browse root
```

For SMB corpus, it prompts:

```text
Use SMB share as project corpus? y/N
SMB share path: \\server\share or //server/share
Optional subfolder inside share
Username
Password (hidden input)
Domain (optional)
```

The installer should:

- Parse `\\server\share`, `//server/share`, and optional subpaths into host, share, and base path.
- Create `$REASONKB_HOME/secrets`.
- Write `$REASONKB_HOME/secrets/smb_username` and `$REASONKB_HOME/secrets/smb_password`.
- Set secret file permissions to `600` where supported.
- Write the SMB env keys into `$REASONKB_HOME/.env`.
- Keep `REASONKB_PROJECTS_ROOT` present only for local corpus installs. For SMB installs, unset or ignore it so Docker does not try to create and mount a dummy local project corpus.
- Optionally run a lightweight connectivity test if the image/tooling is available locally. Failure to test should not block writing configuration, but a failed test should be shown clearly before `docker compose up`.

The final installer summary should show:

```text
Project corpus source: SMB
SMB share: //server/share[/base/path]
Credential files: ~/.reasonkb/secrets/smb_username, ~/.reasonkb/secrets/smb_password
```

It must not print the password.

## Data Model

Existing `documents` fields can represent most SMB metadata:

- `source_kind`: `smb`
- `source_root`: canonical source id such as `smb://host/share/base-path`
- `source_relative_path`: project-relative path under the SMB corpus root, including the first project segment
- `project_relative_path`: path below the project folder
- `source_mtime`: remote mtime in UTC ISO format
- `source_size`: remote file size
- `file_size`: remote file size
- `content_hash`: set during metadata scan to a deterministic metadata fingerprint, `smb-meta:<sha256(source_root + source_relative_path + source_mtime + source_size)>`; replace it with the real `sha256:<digest>` after a successful index-time download.
- `storage_path`: no longer a durable local path for SMB; use a remote locator string such as `smb://host/share/base-path/ProjectA/report.pdf`

Schema changes:

- Add a unique index for active SMB documents:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_smb_source_relative_path
  ON documents(source_root, source_relative_path)
  WHERE source_kind = 'smb' AND deleted_at IS NULL;
```

- Keep the existing directory unique index unchanged.

If implementation needs richer remote state, add a small JSON column or separate table only after proving existing columns are insufficient. The first design should avoid schema expansion beyond the SMB uniqueness index.

The implementation should also confirm that document-store queries and tests do not assume `storage_path` is always a local path for every source kind. Public document responses should continue to hide storage paths.

## Metadata Scan

The SMB scanner lists the configured root recursively using a Python SMB client library. Use `smbprotocol`/`smbclient` unless implementation discovery finds a better fit.

The scanner returns source files with:

```text
remote locator
project name
source relative path
project relative path
media type
mime type
size
mtime
```

The first path segment under the SMB corpus root is the project name, matching local directory corpus behavior.

Change detection uses:

```text
source_mtime changed OR source_size changed OR media_type changed OR document was deleted
```

If unchanged, no content is downloaded and no job is queued.

If the SMB scan fails because the server is unreachable or credentials are invalid, the watcher records the source error and leaves existing SMB documents and projects untouched. A failed scan must not mark all documents deleted.

## On-Demand Fetch During Indexing

When the index worker claims a job for `source_kind=smb`, it should:

1. Resolve the document's remote locator from `source_root` and `source_relative_path`.
2. Download the file to `REASONKB_REMOTE_CACHE_ROOT/<document-id>/<safe-file-name>`.
3. Compute the real file hash while downloading or immediately after download.
4. Pass the temporary local path to the existing `build_pageindex_payload` pipeline.
5. Persist the completed index as today.
6. Update `content_hash` to the real hash when indexing succeeds.
7. Delete the temporary source file after the job, or keep it behind a small TTL/cache limit if that is simpler for Office conversion and retry behavior.

Office conversion can continue to write converted PDFs under the existing converted-file root. The source Office document itself should not become a permanent mirror of the SMB share.

If the download fails, the job fails with an error message that identifies the remote file and the connection/read failure without exposing credentials.

## Error Handling

- Metadata scan authentication failure: record source health as failed; do not delete documents.
- Metadata scan network failure: record source health as failed; do not delete documents.
- Remote file deleted between scan and index: mark job failed; the next successful scan will mark the document deleted.
- Remote file changed between scan and index: index the downloaded bytes; next successful scan will enqueue another job if `mtime + size` changed.
- Unsupported media type: preserve current skipped behavior.
- Credentials missing: fail SMB source initialization with a clear deployment error.

Source health can be logged first. A later Settings UI can surface it directly.

## Security

- Passwords are stored only in secret files for the first version.
- Secret files are mounted read-only into containers.
- Passwords must not be printed in installer summaries, application logs, exceptions, or job errors.
- No Docker `SYS_ADMIN`, no privileged containers, and no CIFS kernel mount.
- SMB traffic uses the remote server's configured SMB security. If the selected client library supports SMB signing/encryption options, expose them later only when needed.

## Tests

Python tests:

- SMB path parser accepts `\\server\share`, `\\server\share\subdir`, `//server/share`, and `//server/share/subdir`.
- Metadata scanner maps first path segment to project name and ignores unsupported/hidden files consistently with local directory scanning.
- SMB sync creates, updates, skips unchanged, and marks deleted documents from metadata without downloading file contents.
- Failed SMB scan does not mark existing SMB documents deleted.
- Index worker fetches an SMB document into a local temporary path before invoking payload building.
- Download failure fails the job without leaking username or password.

Shell/installer tests:

- `install.sh` local flow remains compatible.
- `install.sh` SMB flow writes `.env` SMB keys and secret files.
- `install.sh` accepts both Windows UNC and slash-style SMB paths.
- `install.sh` summary hides the password.

Web tests are not required for first version Settings UI credential management because that UI is out of scope.

## Migration And Compatibility

Existing local deployments continue to use `REASONKB_PROJECTS_ROOT` and `source_kind=directory`.

New SMB deployments set `REASONKB_CORPUS_SOURCE=smb`. Directory watcher runs SMB metadata sync instead of local directory sync. Retrieval and chat are unaffected because they read already-persisted indexes.

The index worker remains backward-compatible with uploaded and local-directory documents. SMB-specific fetch logic should be selected only by `source_kind=smb`.

## Legacy Task

Add Settings UI management for SMB credentials and source status:

- Add/edit/test SMB connection from Settings.
- Store credentials securely outside ordinary SQLite values, or encrypt them with a deployment-managed key.
- Rotate credentials without exposing the current password.
- Show last scan status, last error, and last successful scan time.
- Let administrators switch between local and SMB corpus sources from the UI with clear restart requirements.

# AGENTS.md

## ReasonKB Local Development

Prefer Docker when validating the full product path:
- web app
- retrieval API
- index worker
- directory watcher
- Gotenberg Office conversion
- mounted project corpus

Docker is the best fit for checking deployment behavior, service wiring, ports, environment variables, SQLite state, directory scanning, Office-to-PDF conversion, indexing, and chat retrieval end to end.

Use native local development when changing code:
- frontend UI
- Next.js API routes
- FastAPI retrieval logic
- indexing code
- tests

Native development gives faster feedback, easier logs, `uvicorn --reload`, Next.js dev behavior, and simpler debugger usage. The current Docker setup builds the app into the image and does not mount source code for hot reload, so code edits usually require rebuilding the image.

Recommended hybrid workflow:
- run web and Python services natively for code changes
- run Gotenberg in Docker when Office conversion is needed
- use full Docker Compose before handoff to verify the integrated stack

Default full-stack Docker ports:
- web: `http://localhost:43170`
- retrieval API: `http://localhost:43171`
- Gotenberg: `http://localhost:43172`

Default native development entry points:

```sh
pnpm -C web dev
uv sync --frozen
uv run uvicorn services.retrieval_api.app:app --reload --port 8001
uv run python -m services.index_worker.worker
```

## ACR Release Tagging

Every ACR publication must have a corresponding GitHub tag that points to the exact commit used to build the images.

Before running `./docker/publish-acr.sh`:
- use a clean, fully committed checkout
- choose an explicit release version
- create an annotated tag named `YYYYMMDD-vX.Y.Z`, using the Asia/Shanghai release date and the release version, for example `20260729-v1.4.0`
- push the tag to GitHub and verify that the remote tag exists
- only then build and push the ACR images from that tagged commit

Example:

```sh
ACR_RELEASE_VERSION=1.4.0
ACR_RELEASE_DATE="$(TZ=Asia/Shanghai date +%Y%m%d)"
ACR_GIT_TAG="${ACR_RELEASE_DATE}-v${ACR_RELEASE_VERSION}"
ACR_RELEASE_SHA="$(git rev-parse HEAD)"

test -z "$(git status --porcelain)"
git tag -a "$ACR_GIT_TAG" "$ACR_RELEASE_SHA" -m "ReasonKB ACR release $ACR_GIT_TAG"
git push origin "$ACR_GIT_TAG"
git ls-remote --exit-code --tags origin "refs/tags/$ACR_GIT_TAG"
./docker/publish-acr.sh
```

Never move or reuse an existing release tag. After publishing, inspect the remote ACR manifest and verify that the app image's `org.opencontainers.image.revision` matches `git rev-list -n 1 "$ACR_GIT_TAG"`.

## Worktree Model

This repository uses a worktree-first workflow.

The main repo directory is only for:
- git control operations
- worktree management
- merge/rebase operations

Do not develop directly inside the main repo.

Each agent must:
- work in its own branch
- work in its own worktree
- stay within its assigned task scope

## Starting Work

Before editing, confirm where you are:

```sh
git rev-parse --show-toplevel
git status --short
```

If you are in the main repo directory, create or switch to a dedicated worktree before making changes.

Recommended naming:
- branch: `agent/<task-slug>` or `codex/<task-slug>`
- worktree: `../<repo-name>-worktrees/<task-slug>`

Example:

```sh
git fetch
git worktree add ../<repo-name>-worktrees/<task-slug> -b agent/<task-slug> origin/main
cd ../<repo-name>-worktrees/<task-slug>
```

Reuse an existing branch or worktree only when it clearly belongs to the same task.

## Working In A Worktree

After setup, stay inside the assigned worktree.

Do not modify files from:
- the main repo working directory
- another agent's worktree
- unrelated task branches

Keep changes limited to the assigned task. Avoid touching high-conflict shared files unless necessary:
- package.json
- lockfiles
- shared configs
- CI workflows
- database schemas

If existing changes are present in the worktree, assume they may belong to a human or another agent. Do not overwrite, revert, or rebase them away blindly.

## Finishing Work

Before handing off:

```sh
git status --short
git diff --stat
python3 scripts/check_diagram_impact.py --base origin/main
```

The diagram impact check is required for every code change. If it reports an
affected atlas, inspect the semantic change and either update and browser-test
`docs/architecture/reasonkb-system-atlas.html` or explicitly state in the
handoff why the represented topology or retrieval behavior did not change.
See `docs/architecture/README.md` for the maintained scope and decision rules.

Summarize:
- current branch
- current worktree path
- changed files
- any high-conflict files touched
- whether the branch was rebased or merged before handoff
- diagram impact decision and whether the System Atlas was updated and tested

## Post-Merge Validation Cleanup

After a change is merged into `main`, check for Docker containers created to
validate that change. This includes Compose projects named for the branch or
worktree and one-off `docker run` containers.

- Resolve the exact containers from their names, Compose project labels,
  mounts, and published ports before removing anything.
- Remove all validation containers for the merged change, including stopped
  migration containers and Compose orphans.
- Use the matching Compose project and run
  `docker compose -p <project> down --remove-orphans`; remove one-off
  containers explicitly by name.
- Never use a broad prune as a substitute for identifying the validation
  containers.
- Do not remove the installed `reasonkb` deployment, containers used by other
  active worktrees, volumes, images, or build cache unless that cleanup is
  separately requested.

Report which validation containers were removed and which deployment or active
task containers were intentionally preserved.

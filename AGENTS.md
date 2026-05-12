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
./.venv/bin/uvicorn services.retrieval_api.app:app --reload --port 8001
./.venv/bin/python -m services.index_worker.worker
```

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
```

Summarize:
- current branch
- current worktree path
- changed files
- any high-conflict files touched
- whether the branch was rebased or merged before handoff

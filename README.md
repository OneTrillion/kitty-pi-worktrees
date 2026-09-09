# Pi Worktree

One interactive Pi session, Docker container, host supervisor, and Kitty tab per Git worktree. Git is the persistent source of truth; there is no task registry.

**Status: scaffolding and Phase 2 container-persistence code.** The supervisor and user commands are not implemented yet; Docker/login checks are pending. AI planning and handoff notes live under [`.agents/`](.agents/).

## Development

Requires Node.js **24+**, npm, Git, and a POSIX shell. Docker and Kitty are not needed for the current automated tests.

```sh
npm ci
npm run check        # typecheck, project tests, build
```

Individual checks: `npm run typecheck`, `npm test`, `npm run build`.
Compiled modules appear under `dist/`, preserving the source layout. Node runs the TypeScript tests directly; no test framework or TS runner is needed. Zod is the only runtime dependency, providing strict schemas and inferred types. Development dependencies are TypeScript, Node types, and Pi 0.84.4 for API types/persistence checks. The extension entry point currently does nothing.

## Layout

- `src/shared/` — protocol schemas, framing, request branch policy
- `src/host/` — branch/path validation and fixed Docker launch arguments
- `src/extension/` — typed Pi extension entry point
- `test/` — this project's tests, including checks against real Git
- `docs/protocol.md` — wire format and trust-boundary contract
- `container/` — image integration, entrypoint, and persistence setup
- `kitty/` — host-only tab-bar integration (planned)
- `.agents/` — AI-only handoff notes and implementation plan

## Installation and authentication

See [`container/README.md`](container/README.md) to extend an existing Node 24+/Pi image and set up the shared agent volume. The extension is built into the image, not installed with `pi install`. Final alias/host integration awaits your existing Dockerfile/alias and host OS.

`PI_CODING_AGENT_DIR=/pi/agent` is backed by one shared read/write Docker volume. Run `/login` once; subsequent containers reuse authentication. Worktrees keep their host absolute paths, with explicit per-worktree session directories to avoid collisions. Never bake credentials into the image.

## Commands (planned)

| Command | Purpose |
| --- | --- |
| `/worktree <branch>` | Create or reopen a task in a new tab; retain the current session |
| `/worktrees` | List live Git-derived state and reopen a selected worktree |
| `/worktree-done` | Require committed, conflict-free work; mark this tab done transiently |
| `/worktree-sync` | Merge the local upstream into the task; leave conflicts in the task |
| `/worktree-merge <branch>` | From the target tab, integrate the task fast-forward-only |

New task branches record the source local branch as their upstream/integration target. **Do not replace that upstream with `git push -u`**; push without changing the local parent relationship. Missing or remote upstreams will block sync/integration rather than guessing a target.

Closing tabs will preserve worktrees, branches, changes, and saved Pi sessions. Worktree/branch deletion remains an explicit host-side Git operation. Unsubmitted editor text may be lost. A host list/open mode will provide recovery when all tabs are closed.

## Security model

The intended container mounts are its own worktree, common Git metadata, the shared Pi agent volume, and its private supervisor socket. Docker and Kitty sockets stay on the host. Requests cannot specify host commands, filesystem paths, image/options/mounts, or Kitty targets. See [the protocol contract](docs/protocol.md).

Every task container can read shared provider credentials and alter shared Git metadata. Requests for valid new worktrees/containers have no confirmation or rate limit, so resource exhaustion is an accepted risk. Repository-controlled hooks, config, filters, symlinks, and worktree metadata need separate host-side hardening; strict JSON validation alone is **not** a sandbox. That host-side hardening has not been implemented yet.

These commands will never run user project tests, lint, builds, CI, or services. Development checks in this repository test this software only.

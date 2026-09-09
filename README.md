# Pi Worktree

One interactive Pi session, Docker container, host supervisor, and Kitty tab per Git worktree. Git is the persistent source of truth; there is no task registry.

**Status: Phase 1 scaffolding only.** The supervisor, image integration, and user commands are not implemented yet. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) and the handoff in [CONTEXT.md](CONTEXT.md).

## Development

Requires Node.js **22.19+**, npm, and Git. Docker and Kitty are not needed for the current tests.

```sh
npm ci
npm run check        # typecheck, project tests, build
```

Individual checks: `npm run typecheck`, `npm test`, `npm run build`.
Compiled modules appear under `dist/`, preserving the source layout. Tests use Node's built-in runner through `tsx`; Zod provides strict runtime schemas and inferred TypeScript types. Pi 0.84.4 is pinned as a development dependency for extension API types; the eventual image must provide the matching Pi runtime. The extension entry point currently does nothing.

## Layout

- `src/shared/` — protocol schemas, framing, request branch policy
- `src/host/` — Git branch validation and deterministic path/identity helpers
- `src/extension/` — typed Pi extension entry point
- `test/` — this project's tests, including checks against real Git
- `docs/protocol.md` — wire format and trust-boundary contract
- `kitty/` — host-only tab-bar integration (planned)

## Installation and authentication (planned)

The extension will be built into your Pi image, not installed with `pi install`. A host launcher will replace the existing Docker alias. Installation details await the existing Dockerfile/alias and host OS.

The image will set a fixed `PI_CODING_AGENT_DIR`, backed by one shared read/write Docker volume. Run `/login` once; subsequent containers reuse authentication and sessions. Worktrees retain their host absolute paths inside the container so session discovery stays stable. Never bake credentials into the image.

## Commands (planned)

| Command | Purpose |
| --- | --- |
| `/worktree <branch>` | Create or reopen a task in a new tab; retain the current session |
| `/worktrees` | List live Git-derived state and reopen a selected worktree |
| `/worktree-done` | Require committed, conflict-free work; mark this tab done transiently |
| `/worktree-sync` | Merge the local upstream into the task; leave conflicts in the task |
| `/worktree-merge <branch>` | From the target tab, integrate the task fast-forward-only |

New task branches record the source local branch as their upstream/integration target. **Do not replace that upstream with `git push -u`**; push without changing the local parent relationship. Missing or remote upstreams will block sync/integration rather than guessing a target.

Closing tabs will preserve worktrees, branches, changes, and submitted Pi sessions. Worktree/branch deletion remains an explicit host-side Git operation. Unsubmitted editor text may be lost. A host list/open mode will provide recovery when all tabs are closed.

## Security model

The intended container mounts are its own worktree, common Git metadata, the shared Pi agent volume, and its private supervisor socket. Docker and Kitty sockets stay on the host. Requests cannot specify host commands, filesystem paths, image/options/mounts, or Kitty targets. See [the protocol contract](docs/protocol.md).

Every task container can read shared provider credentials and alter shared Git metadata. Requests for valid new worktrees/containers have no confirmation or rate limit, so resource exhaustion is an accepted risk. Repository-controlled hooks, config, filters, symlinks, and worktree metadata need separate host-side hardening; strict JSON validation alone is **not** a sandbox. That hardening has not been implemented in Phase 1.

These commands will never run user project tests, lint, builds, CI, or services. Development checks in this repository test this software only.

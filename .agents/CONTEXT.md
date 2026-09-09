# Implementation handoff

## User instructions and checkpoint

- Follow `.agents/plans/IMPLEMENTATION_PLAN.md` step by step; pause for review after each checkpoint.
- Node **24+**, keep code simple/dependencies few. AI-only artifacts belong in `.agents/`; never recreate root CONTEXT.md or IMPLEMENTATION_PLAN.md. README/docs/container/kitty documentation is for users/contributors.
- **Phase 3c supervisor code is implemented. Pause for review. Next: Phase 4 worktree creation/opening and Kitty launch integration.** Pi extension is still a typed NO-OP, and the running server returns `unavailable` for every valid operation until handlers are added.
- User still hasn't supplied their existing image/Dockerfile, alias or actual host OS despite repeated “next step” approvals. Current host code explicitly supports Linux. Do not confuse this test environment with deployment confirmation.
- This turn started clean at commit `4bf0e34`. No commits made by assistant. Use `git -c safe.directory=/workspace ...`; no global safe.directory changes.

## Verification / limits

- Latest `npm run check`: **150 tests passed**, typecheck/build passed (Node 24.20.0, Linux, Git 2.39.5, util-linux flock 2.38.1).
- New supervisor/config/CLI subset: **32 tests passed as non-root user `node`** too.
- Compiled `dist/host/supervisor.js` + compiled Docker client completed a create/attach/cleanup cycle against the fake daemon. Earlier compiled CLI inspection and socket round-trip checks passed. `git diff --check` passed.
- **Docker and Kitty executables are absent.** All new lifecycle checks use a controlled fake Docker CLI/daemon, real process signals, actual Unix sockets/flock, and temporary Git repositories. No real image build, Docker bind behavior, UID mapping, PTY/terminal restoration, tab-close, /login or OAuth smoke verification. Clearly preserve this distinction.
- No user project checks were run. Normal Git mutation exists only in temporary test fixtures. Dependencies and lockfile unchanged this phase.

## Build / layout

TypeScript ESM/NodeNext -> `dist/`; Node runs `.ts` tests directly. Relative imports use `.ts`, TS `rewriteRelativeImportExtensions` emits `.js`, `erasableSyntaxOnly` avoids non-strippable syntax. No tsx/bundler/test framework. Zod is the only runtime dependency; TypeScript, Node types and Pi 0.84.4 are dev dependencies.

User docs: `docs/host.md` (config/start/inspect/recover and lifecycle), `docs/protocol.md`, `container/README.md`, README. Keep handoff notes here, not in user docs.

## Phase 3c — important lifecycle decisions

### Entry points

- `src/host/cli.ts`: `inspect`, `start`, `recover`, all requiring explicit `--config /absolute/file.json`; --help supported. `start` requires terminal stdin/stdout and non-root host UID/GID. It best-effort restores stdin raw mode on exit. Errors/inspection use ASCII-escaped JSON for terminal safety.
- `src/host/supervisor.ts`: `runHostSession(config, cwd, mode, options?)`. One invocation per process/tab. Options for Docker factory/container UID and retry delay are trusted test seams, NOT CLI/config/protocol fields.
- `src/host/docker-client.ts`: fixed `/usr/bin/docker`, explicit local Unix endpoint, fresh environment and empty per-session Docker CLI config directory. No inherited DOCKER_HOST/CONTEXT, ~/.docker config/credential helpers, project PATH, NODE_OPTIONS or provider credentials. Captured control commands have 20s timeout/SIGKILL and bounded output; attached start inherits stdio. Structured inspect subset validated with Zod. Failed daemon queries are never treated as absence.
- Host config now has optional **dockerSocket**, default `/var/run/docker.sock`. Reject TCP/SSH URLs and task-mounted endpoints. At use time resolve canonical target and require a socket owned by this UID/root outside task mounts. Rootless/custom local socket selection is possible, but UID/user-namespace mapping still needs real testing.

### Create, then attach (not docker run --rm)

1. Discover authorized current worktree and record directory device/inode identities.
2. Prepare shared private runtime root and acquire canonical-worktree advisory lock.
3. Create a private Docker control/config directory. Check deterministic container name; refuse ANY existing container, including stopped managed leftovers.
4. Start private request server. Revalidate Git paths, directory inodes and owned mode-0600 socket identity.
5. `dockerCreateArgs` builds `create --pull=never --restart=no`, preserving fixed mounts/UID/options. Image must already exist locally. Supervised containers deliberately have NO --rm/auto-remove.
6. Labels: `io.pi-worktree.managed=1`, worktree path hash, common Git path hash, random run UUID. Verify full returned ID, labels and expected name; revalidate mounts/metadata/socket again.
7. `docker container start --attach --interactive <verified-full-id>` while serving requests. No task registry or persistent done flag. Labels are runtime ownership only.

`dockerRunArgs` remains a pure shared argument builder for earlier tests/auth-style use; managed startup uses `dockerCreateArgs` and explicit removal instead.

### Cleanup and orphan handling

- Normal completion propagates the attached Docker CLI's exit status. SIGINT/SIGTERM/SIGHUP initiate shutdown, exit 130/143/129 respectively. Optional AbortSignal is supported. No arbitrary Git/project commands during shutdown.
- Stop accepting requests/abort handlers. Docker control has its OWN private directory, separate from the server's socket directory, so server cleanup cannot invalidate Docker command cwd/config.
- Stop verified container ID with 10-second Docker grace period, remove by full ID without --force/--volumes, and confirm ID is absent. Then disconnect/kill attached Docker CLI if still needed. Wait for all request handlers (server.close uses allSettled), remove private dirs, release lock, unregister signal handlers.
- **If state/stop/removal cannot be confirmed, retain the OS lock and retry (default 2s between bounded attempts).** Print a notice once. Reporting errors must not interrupt cleanup. The per-tab supervisor may remain alive after tab closure until daemon access is restored. Repeated termination signals do not bypass cleanup.
- A create error/timeout may leave a stopped container. Find it using expected name + this run's UUID/scope labels before cleanup. Never remove a foreign/racing container. Separating create/start means a late create response cannot launch an editor after cancellation/process death.
- **SIGKILL is uncatchable:** OS releases lock, but Docker may still run or retain a stopped container. Next start refuses the occupied deterministic name. Explicit HOST-ONLY `recover` must acquire the same lock and validate managed/worktree/repository labels + UUID before stopping/removing that exact ID. Active managed tab/unrecognized collision refused; no leftover is a no-op. No recover protocol operation.
- Recover never removes Git worktrees/branches/changes or named Pi volumes. It doesn't sweep old per-tab runtime directories left by SIGKILL. Do not unlink lock files or delete other tabs' directories.
- All sessions/recovery for a worktree must use the SAME local Docker daemon and shared runtime root. Changing endpoint/runtime-root while old containers may survive defeats cross-session coordination; no registry tracks alternate endpoints.

### New tests

`test/supervisor.test.ts` plus fixtures exercise normal exit, request service while attached, dirty/untracked preservation, duplicate refusal, foreign/name-race protection, lost create reply, failed attach, cancellation during create, Git/root inode/socket replacement, cleanup uncertainty retaining locks, environment isolation, real SIGINT/TERM/HUP and SIGKILL during both create and running state, recovery and reopen. `fake-docker-cli.ts` uses persistent **TEST-ONLY** daemon state; none of this registry/fake machinery is shipped in the image or production host code.

## Host config / discovery security (Phase 3b)

- `config.ts`: strict, frozen host JSON. Required image, named agentVolume, repositoryPath, worktreeRoot, runtimeRoot; optional dockerSocket. No auto project discovery/interpolation/commands. File regular, no symbolic/hard links, owner UID/root, not group/world writable, <=64 KiB.
- Main checkout must have an actual `.git` directory. Main/task roots existing, canonical and non-nested; task worktrees are immediate children of dedicated task root. Runtime parent must exist. Config, installation including deps, Node/Docker executables, runtime and Docker socket must stay outside task mounts. Install a trusted copy outside this repo when supervising this project's own worktree.
- `files.ts` bounded regular metadata reads O_NOFOLLOW/O_NONBLOCK and canonical-directory checks. Linked pointer reads <=8 KiB.
- `git-discovery.ts`: live `git worktree list --porcelain -z`; authorize paths independently of Git metadata. Validate linked .git/commondir/backlinks against this configured common directory. Resolve cwd aliases/subdirectories; refuse nested repos/submodules, unauthorized/unregistered paths, symlinked/inconsistent metadata, bare/separate-Git layouts, unborn/unreadable HEAD. Supports detached HEAD, SHA-1/SHA-256 and unusual existing Git-valid branch names. No repair/mutation.
- Private discovery runner ONLY uses worktree-list, symbolic-ref, check-ref-format, rev-parse. Absolute /usr/bin/git, neutral cwd, fresh env, explicit Git/worktree/common paths, no automatic system/global config, no pager/optional locks/hooks/fsmonitor. 5s timeout, bounded output. Repository config/includes STILL read.
- **Keep GIT_NO_LAZY_FETCH=1, GIT_ALLOW_PROTOCOL="", GIT_NO_REPLACE_OBJECTS=1.** A regression test actually reproduced rev-parse invoking a configured remote helper for a missing promisor object before these guards were added. Older branch-name helper also uses absolute Git/fresh env now.
- **NOT a general safe Git runner. Do NOT add status/checkout/worktree-add/merge/fetch to it.** Those can run repository-controlled programs. Phase 4 must choose execution isolation (e.g. constrained helper containers) rather than silently broadening this host runner. No isolation design for Git mutation has been implemented yet.
- Common Git is ALWAYS a separate Docker bind, even inside main checkout: a container must not be able to replace `.git` with a symlink redirecting future binds. Never mount the task-root parent into task containers. Revalidation detects observed replacements, not arbitrary concurrent hostile HOST filesystem edits; real bind/TOCTOU behavior still needs smoke verification.

## Runtime / protocol invariants (Phase 3a)

- Shared host runtime root owned by UID, mode 0700, canonical; private per-tab dirs; sockets <=100 UTF-8 bytes, mode 0600. Reject insecure/symlink roots, don't repair permissions.
- util-linux flock locks inherited fd 3; utility exits while Node retains same open file description. Close/death releases OS lock. File is owned regular mode 0600, one link, O_NOFOLLOW/O_NONBLOCK. **Never unlink lock files on release** (inode races). Files empty, not persisted open state. Keep handles reachable; don't accidentally pass them to children. `isWorktreeOpen` is a lock snapshot; a closed lock can still have a Docker orphan.
- Protocol v1: create-or-open(branch), list, open(ID), inspect(ID), strict keys. No container-supplied paths/source branches/commands/images/options/Kitty targets. IDs = hash of canonical path, NOT secret authorization tokens; match live Git against host policy each request.
- One request/response per Unix stream: uint32 BE length + UTF-8 JSON, request <=16 KiB, response <=1 MiB. Client half-closes, server allowHalfOpen, validates at EOF before dispatch; reject trailing/multiple frames.
- Server absolute input/write deadlines 5s; handler gets AbortSignal and must wait for its children. Monitor failure promise (resolves Error). Client total deadline 30s; no automatic retries. Timeout/cancel can mean unknown result, not rollback. No count/rate limits. Oversize lists return response-too-large, never silent truncation.
- `inspection: unavailable` must not claim clean. Runtime open differs from Git locked. No persistent done state. Untrusted strings require safe UI display. Forced socket shutdown can yield ECONNRESET instead of EOF; tests handle both without unhandled promises.

## Image / Pi persistence (Phase 2, real smoke tests pending)

- `container/Dockerfile` overlays REQUIRED PI_BASE_IMAGE, no guessed base. Build stage Node 24; base must provide Node 24+, Pi 0.84.4, Git/bash/sh. No second Pi or pi install. Built-in compiled extension/shared/Zod at root-owned /opt/pi-worktree, outside volume. .dockerignore allowlists source/build inputs, excludes .agents/Git/credentials.
- Fixed PI_CODING_AGENT_DIR=/pi/agent, one shared RW named volume. UID/GID args default 1000, private agent dir owned accordingly. New volumes inherit ownership; old volumes not auto-chowned. Overrides base entrypoint/CMD/user/HOME/workdir: review user's required initialization.
- start.sh checks volume writable, creates ephemeral HOME, execs Pi with explicit extension and --continue. Direct auth-only Docker example may use --rm; managed start does not.
- Stable absolute worktree/common paths, private supervisor socket only, no Docker/Kitty socket or host credentials mounted. Explicit --session-dir /pi/agent/sessions/<worktree-id> avoids Pi slash-to-dash cwd collisions and project sessionDir relocation. Old default/alias sessions aren't automatically migrated.
- Pi 0.84.4 flushes a new session only after first assistant message; don't promise every submitted first message survives abrupt shutdown. Every task can read credentials and modify shared agent settings/extensions; don't share this directory with trusted host Pi if isolation matters.
- Pi persistence tests use fresh processes/temp directories/synthetic credentials; auth test resolves pinned Pi's internal AuthStorage only in tests. Production has no internal Pi auth dependency.

## Next: Phase 4

1. Resolve safe execution for Git creation/status operations before adding host request handlers. Preserve local-upstream parent semantics and all existing branches/worktrees; no force, automatic project checks or registry.
2. Implement create-or-open + new Kitty tab invocation with ONLY fixed host command/config and host-selected targets. Implement `/worktree` as a Pi command (not an LLM tool); keep current session open. Listing/recovery selector is Phase 5.
3. Obtain user's image/alias/host details and run real Docker/TTY/Kitty smoke tests when available; do not claim fake tests cover mounts, namespaces or terminal behavior.
4. Update this handoff and pause for review.

Pi docs previously fully read: extensions, containerization, environment-variables, sessions, settings, session-format, providers; hello example and relevant auth/session implementation. Installed docs root: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/`. No Pi API changes/docs reading needed for 3c. Read complete relevant docs/examples and related cross-references before future Pi work. Reminders: registerCommand bypasses LLM; UI setTitle; idle uses agent_settled not agent_end; create background resources at session_start/commands, close idempotently at session_shutdown, not from factory.

# Implementation handoff

## User instructions / checkpoint

- Implement `.agents/plans/IMPLEMENTATION_PLAN.md` step by step, pausing for code review.
- Node **24+**, simple code, few dependencies. AI-only notes/plans stay in `.agents/`; do not recreate root CONTEXT.md or IMPLEMENTATION_PLAN.md. User/contributor docs remain in README, docs/, container/, kitty/.
- **Current checkpoint: Phase 3b complete — explicit host config, constrained read-only Git discovery, inspect-only CLI. Pause for review. Next is Phase 3c Docker lifecycle integration.** Plan checkpoints were refined accordingly. No runnable Docker supervisor or Pi commands yet.
- Still awaiting user's existing Dockerfile/image workflow, launch alias and actual host OS. User has repeatedly said “next step” without providing these. Do not treat the Linux test environment as deployment confirmation. Current host backend explicitly supports Linux only.
- No commits by assistant this turn. Starting baseline was `d61c63a` (Phase 3a), working tree initially clean. Git commands use `git -c safe.directory=/workspace ...`; no global Git config changes.

## Structure and dependencies

- TypeScript ESM/NodeNext -> `dist/`. Source relative imports end in `.ts`; `rewriteRelativeImportExtensions` emits `.js`; `erasableSyntaxOnly` keeps native Node TS execution working. Tests use `node --test`, no tsx/bundler/framework.
- Runtime dependency: Zod (strict schemas + inferred types). Dev dependencies: TypeScript, Node 24 types, Pi 0.84.4. No new dependencies/lockfile changes in 3a/3b.
- `src/extension/index.ts` remains a typed NO-OP. No background resources/Pi commands were registered.
- `src/shared/branch.ts`, `src/host/branch.ts`, `paths.ts`: strict literal request-branch policy, authoritative check-ref-format, bounded directory slug + full branch SHA-256, ID = SHA-256 of canonical worktree path. The older host branch validator now also uses absolute `/usr/bin/git`, neutral cwd/fresh environment, not inherited PATH/GIT_*; tested under poisoned PATH. No persistent task mapping.

## Phase 3b delivered

### Configuration / filesystem boundary

- `src/host/config.ts`: `loadHostConfig(absoluteConfigPath)` loads strict JSON with exactly `image`, `agentVolume`, `repositoryPath`, `worktreeRoot`, `runtimeRoot`. Returns a frozen object. No project config search, shell interpolation, filesystem creation, permissions repair, or task registry.
- File must be regular, no symlink/hard links, owned by current UID or root, not group/world writable, <=64 KiB. Parent path must be canonical. Linux-only currently.
- Repository/main checkout and task-root directories must already exist, be canonical and non-nested. Main checkout must have an actual `.git` directory (no separate Git dir or bare main repo in this initial policy). Its branch need not be `main`.
- Linked worktrees must be immediate children of the dedicated task root. Config, canonical installation/package root (including dependencies), canonical Node executable, and runtime root must not overlap either mounted root. Runtime parent must exist; runtime root creation remains with runtime helper.
- `src/host/files.ts`: bounded regular-file reads using O_NOFOLLOW/O_NONBLOCK and fstat, plus canonical-directory/containment helpers. Pointer reads <=8 KiB. Do not mistake lexical/realpath checks for a general race-proof filesystem sandbox.
- `docs/host.md` gives config example, setup, inspect command and restrictions. These are user/contributor docs, not AI-only notes.

### Discovery / diagnostic CLI

- `src/host/git-discovery.ts`: `discoverCurrentWorktree(config, cwd, signal?)` uses live `git worktree list --porcelain -z`, not a registry. It resolves cwd aliases, chooses the authorized worktree, checks canonical directories and linked `.git`/`commondir`/`gitdir` backlinks, then reads local branch/detached HEAD and commit.
- Returns `{ worktreePath, gitDir, commonGitDir, branch: string|null, head }`. Supports main/linked worktrees, cwd subdirectories, detached HEAD, SHA-1/SHA-256, Git-valid existing names broader than request-name policy. Refuses nested repos/submodules, unauthorized/unregistered worktrees, symlinked metadata directories/pointers, inconsistent pointers, unborn/unreadable HEAD. Never repairs or changes the repository.
- Private Git runner ONLY calls worktree-list, symbolic-ref, check-ref-format and rev-parse. Absolute `/usr/bin/git`, cwd `/`, fresh environment (no inherited PATH/GIT_*), explicit --git-dir/--work-tree/GIT_COMMON_DIR, no automatic system/global config, no pager/optional locks/hooks/fsmonitor, 5-second timeout/SIGKILL, bounded output. Repository config/includes are STILL read.
- **Critical finding reproduced and fixed:** `rev-parse HEAD^{commit}` can lazily fetch a missing promisor object and execute a configured remote helper. Regression test first demonstrated a harmless marker script executing, then passed after setting `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=""`, and retaining `GIT_NO_REPLACE_OBJECTS=1`. Never drop these guards.
- **NOT a general safe Git runner.** Do not add status/checkout/worktree-add/merge/fetch etc. to this helper. They can execute additional repository-controlled programs. Separate execution isolation is still required for later operations; consider constrained helper containers rather than an ever-growing host Git denylist (design not yet implemented/settled).
- `src/host/cli.ts` currently supports only `inspect --config /absolute/host.json` and --help. Outputs ASCII-escaped JSON (including Unicode/bidi/control handling) and JSON errors on stderr, exit 1. Does not lock/reserve, start Docker, run checks or mutate Git. Build then run `node /trusted/install/dist/host/cli.js inspect --config ...` from target worktree. Installed code must be outside target mounts; this project cannot safely supervise its own mounted source checkout without a separate trusted copy.

### Mount correction (important)

`src/host/docker.ts` now ALWAYS mounts common Git separately, including inside the main checkout. Previous “skip redundant mount” optimization was unsafe: that container could otherwise replace `.git` with a symlink redirecting a later host bind. A separate Linux bind mount point prevents replacing that directory from inside the container. The task-root parent must likewise never be mounted into task containers. Actual Docker behavior/revalidation races remain unverified here; do not claim this completes lifecycle security.

## Previously delivered runtime / protocol

- `runtime.ts`: host-selected canonical UID-owned root mode 0700, private per-tab directories, socket path <=100 UTF-8 bytes, idempotent per-tab removal. Reject insecure/symlink roots rather than repairing them.
- `lock.ts`: util-linux `/usr/bin/flock` locks inherited fd 3; utility exits while Node retains the same open file description. Parent close/process death releases OS lock. No daemon/native addon/PID registry. Canonical path aliases share lock. Require owned regular mode-0600 file, one hard link; O_NOFOLLOW/O_NONBLOCK. **Never unlink lock files on release**. Empty files contain no persisted open/closed state. `isWorktreeOpen` is a snapshot only.
- All supervisors must share the SAME runtime root on a local filesystem. Keep lock handles reachable and avoid accidental child inheritance. Abrupt death can leave a socket directory, but not a held OS lock; do not auto-delete other tabs' directories.
- Strict protocol v1: create-or-open(branch), list, open(ID), inspect(ID); no path/source-branch/command/image/Docker-options/Kitty-target request fields. IDs aren't authorization tokens; rediscover against host-authorized Git entries on every request.
- Frame: uint32 BE byte length + UTF-8 JSON; request <=16 KiB, response <=1 MiB. One request/response per connection. Client half-closes; server allowHalfOpen, validates at EOF before dispatch. Reject malformed/trailing/multiple frames. No count/rate limits; oversize lists return response-too-large, not truncation.
- `server.ts`: private 0600 socket; absolute input/write deadlines 5s (not handler timeout). Trusted handler gets Request + AbortSignal. `close()` aborts/destroys connections, waits for handlers, then removes tab directory. Monitor `failure` (resolves Error, doesn't reject). Handler exceptions/schema bugs become generic internal-error without leaking exception text.
- `client.ts`: validates request and full response/matching op at EOF; total deadline 30s, AbortSignal, no retries. Timeout/cancel/disconnect can mean unknown operation outcome, not rollback/cancellation proof.
- `done` isn't persistent Git/protocol state. Unavailable inspection cannot claim clean. Runtime open and Git locked differ. Response strings remain untrusted display data.

## Container / Pi persistence (Phase 2, deployment checks pending)

- `container/Dockerfile` overlays REQUIRED `PI_BASE_IMAGE`, not a guessed replacement. Build stage Node 24; runtime base must provide Node 24+, matching Pi 0.84.4, Git/bash/sh. No second Pi install or pi install. Copies compiled extension/shared modules + Zod to root-owned `/opt/pi-worktree`, outside volume.
- Fixed `PI_CODING_AGENT_DIR=/pi/agent` RW named volume for auth/settings/models/sessions. UID/GID args default 1000; private agent dir owned accordingly. New volumes inherit ownership; existing ones aren't auto-recursively-chowned. Overrides base entrypoint/CMD/user/HOME/workdir: review required base initialization with user.
- `container/start.sh` checks volume writable, creates ephemeral HOME, execs Pi with explicit extension and --continue. `.dockerignore` allowlists build inputs, excludes credentials/.agents/Git data.
- Docker argv builder remains PURE: attached --rm --init, non-root host UID/GID, fixed image/named volume/options, caps dropped/no-new-privileges, stable absolute worktree/common-Git paths, private socket read-only bind. No host environment/control sockets/credential directories forwarded.
- Explicit `--session-dir /pi/agent/sessions/<worktree-id>` avoids Pi 0.84.4 slash-to-dash cwd encoding collisions (`/a/b` vs `/a-b`) and overrides project sessionDir relocation. Old alias/default sessions are not migrated automatically.
- Pi 0.84.4 only flushes a brand-new session after its first assistant message. Don't promise all submitted first messages survive abrupt shutdown. Shared agent config/extensions/auth are container-writable; don't share with trusted host Pi if host execution isolation matters.

## Verification

- Latest full check: **125 tests passed**, typecheck/build passed on Node 24.20.0, Linux, Git 2.39.5, flock 2.38.1.
- New config/discovery/CLI subset: **21 tests passed as non-root `node`** as well. Includes actual temporary Git repos/worktrees, detached/SHA-256, dirty/untracked preservation, hostile pointers/config/environment and the reproduced lazy-fetch remote-helper attack. CLI tests check argument rejection and terminal-safe JSON. Compiled CLI --help and an actual compiled inspect run against a temporary Git repository both passed. `git diff --check` passed.
- Earlier tests cover strict protocol/framing, Docker args, entrypoint with fake Pi, actual Pi persistence across fresh processes with synthetic credentials, concurrent auth locking, Unix-socket deadlines/shutdown, real flock contention/aliases/inodes/SIGKILL. Runtime/socket subset previously repeated 3x and passed non-root; compiled transport round trip passed.
- AuthStorage isn't public in pinned Pi: only tests resolve internal core/auth-storage.js to exercise its real file-locking backend. Production doesn't depend on this internal API. SessionManager is public.
- Forced socket shutdown with unread data may give ECONNRESET instead of EOF; intentional-shutdown tests accept either, with rejection handlers attached immediately.
- **Docker and Kitty absent.** No image build, real /login/OAuth, volume population/ownership, actual socket bind, mount-point protection or tab/container smoke verification. No user project checks run; normal Git mutation exists only in temporary test fixtures.

## Next: Phase 3c

1. Implement attached Docker execution and signals/cleanup around config -> discovery -> runtime/lock/socket. Revalidate authorized mount boundaries at launch; monitor server.failure; keep lock until container shutdown AND all host request handlers finish.
2. Solve orphan-container handling explicitly. Supervisor SIGKILL releases its fd but does NOT prove Docker stopped. Deterministic Docker names reject duplicates but aren't complete stop/cleanup logic. Do not kill an unrelated existing container by name or advertise full crash recovery prematurely.
3. Confirm user's base image/alias/host OS and perform available deployment smoke checks. No Docker here; use controlled process/CLI fakes where useful and label those as non-container tests.
4. Creation/status/integration commands still need isolation from writable Git hooks/config/filters/promisor helpers and mutable metadata paths. No automatic commits/merges/repairs/deletions/project checks.
5. Update this handoff and pause for review.

Pi docs previously fully read: extensions, containerization, environment-variables, sessions, settings, session-format, providers; hello example; relevant auth/session implementation. Installed docs: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/`. No Pi API work/docs reading needed for 3b. For later Pi work read full relevant docs/examples and follow related references. Lifecycle reminders: registerCommand bypasses LLM, setTitle via UI, idle uses agent_settled not agent_end, background resources only from session_start/commands with idempotent session_shutdown cleanup.

# Implementation handoff — paused at user's request

## Resume instructions / current status

- **The user explicitly asked to PAUSE and document progress. Do not continue implementation until asked.** Their previous instruction was to finish the remaining plan without intermediate reviews; the latest pause overrides that for now.
- Plan: `.agents/plans/IMPLEMENTATION_PLAN.md`. AI-only notes stay in `.agents/`; never recreate root CONTEXT.md or IMPLEMENTATION_PLAN.md. User/contributor docs belong in README/docs/container/kitty.
- Keep Node **24+**, simple implementation, few dependencies. No new npm dependencies have been added: Zod runtime; TypeScript, Node types, Pi 0.84.4 dev dependencies.
- Started this work clean at **`6646c3d` (`start and recover host`)**. All work described below is **uncommitted**, including many new/untracked files. No assistant commits. Use `git -c safe.directory=/workspace ...` for inspection; no global safe.directory changes.
- Most remaining feature code (Phases 4–7) is now implemented and tested. **The project is NOT finished:** final hardening/review, additional recovery/smoke tests, and user documentation are still pending. README/docs/kitty README still describe earlier checkpoints and must be updated.
- Latest full `npm run check`: **181 tests total, 180 passed, 1 skipped, 0 failed; typecheck and build passed.** The skipped test requires system Python for the Kitty renderer. This check ran immediately before the pause; no implementation changes were made after it.
- This environment has Node 24.20.0 and Git 2.39.5. **Docker, Kitty, Python 3 and curl are absent.** Tests use real temporary Git repos, OS locks/Unix sockets, fake Docker/Kitty executables and mocked Pi UI. Do not claim actual image builds, mounts, UID namespaces, PTY/Kitty rendering, /login or OAuth smoke checks passed.
- User still has not supplied their existing Dockerfile/image, launch alias or actual host OS. Current host support remains Linux. Optional reference base image was added; don't pretend it is their existing workflow.

## Work added during this session

### 1. Shared Git backend, status, completion and integration

New `src/git/operations.ts` implements `GitOperations`, intended to run **inside task/helper containers**, or temporary test fixtures — **never on host projects**:

- Explicit worktree/Git/common paths and fresh environment; no inherited Git variables/global config.
- Hooks, fsmonitor, maintenance/auto-GC, signing, automatic editor and remote/lazy fetch disabled. Keep `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=""`, `GIT_NO_REPLACE_OBJECTS=1`.
- `prepare()` obtains callback KEY NAMES using `git config --null --name-only --get-regexp '^(filter|merge)\.'`, avoiding newline ambiguity in values. Configured clean/smudge filters are replaced with `/bin/cat`, process filters disabled, required=false; external merge drivers replaced with `/bin/false`. Callback keys containing `=` or control/format characters are refused rather than escaping the `-c key=value` overrides. This avoids intentionally running project checks/hooks. Config can still change concurrently; the helper container is the host execution boundary, not a claim of protecting a task from itself.
- `state()` derives branch, commit, upstream, dirty/untracked files, conflicts, merge/rebase state and status priority from live Git. Upstream resolution checks Git ref syntax before commit resolution (no `main~0` revision-as-parent). Local upstream means remote `.` and one `refs/heads/...` merge ref; ambiguous/missing/remote configs aren't guessed.
- `done()` checks clean/conflict-free/committed only. No tests/lint/CI/build/service commands, no commit creation.
- `sync()` requires a clean task with resolving local parent, merges parent commit using merge/no-edit/no-verify/no-sign. Returns conflict state without undoing it; target branch untouched.
- `integrate()` checks clean target, selected task's local parent relationship, fresh host inspection of task files/head, target ancestor of task, then revalidates heads/parent and runs **ff-only** merge of captured task commit. No automatic task/branch deletion. Checks are snapshots, not protection against arbitrary simultaneous manual/agent edits in another worktree.
- Submodule/gitlink worktrees are explicitly refused for managed checks/integration to avoid uncontrolled recursive callbacks. Active cherry-pick/revert/sequencer state also refused. These restrictions need user docs. Callback/attribute-dependent (e.g. LFS expanded) worktrees can be conservatively dirty when filters are disabled.

New `src/shared/git-state.ts`: snapshot schema, status priority classifier and clean precondition.
New `src/shared/title.ts`: fixed `pi-worktree:<state>:<task>` title format, whitelist parser and bounded plain-text sanitizer (control/bidi/surrogate/line separators removed).
New `src/shared/worktree-records.ts`: NUL Git worktree porcelain metadata (path, branch, head, Git locked/prunable reasons).

### 2. Credential-free isolated Git helpers

New `src/shared/helper.ts`, `src/git/worker.ts`, `src/git/worker-cli.ts`:
- Fixed internal worker requests: inspect or create. Location/path data is supplied ONLY by trusted host code and never accepted by the host socket protocol.
- Worker runs shared Git backend; returns strict JSON snapshot/success/error. All command output captured, errors sanitized/bounded.
- Creation: preserve existing branch/upstream. For new branch, create at captured source HEAD with no tracking, set source local branch as upstream, then normal non-forced `git worktree add`. Source branch/head revalidated; detached new-branch creation rejected. No rollback/reset/deletion on failure.

New `src/host/git-helper.ts`:
- OS repository-operation mutex reuses `acquireWorktreeLock(runtimeRoot, commonGitDir)`, distinct from task lifetime locks. Normal requests wait with cancellation; this is serialization, not rate/count limiting or a registry.
- One deterministic helper container name per repo: `pi-worktree-git-<commonGitHash>`. Prevents another helper starting after an owner's uncatchable death.
- Creates stopped, verifies ownership, captures attached worker output, then confirms stop/removal while retaining repo lock. Uses shared cleanup retry policy.
- Helper is fixed image, non-root, read-only rootfs, **network=none**, dropped caps/no-new-privileges, writable tmpfs `/tmp`. **No agent/auth volume, supervisor socket, Docker socket or Kitty socket.** Inspection mounts selected worktree/common Git read-only. Creation mounts **only a host-precreated empty destination and common Git RW**, not the destination's parent or source worktree files. Source main directory exists inside container just to house common Git bind.
- Helper scope labels use configured main checkout/common Git hashes + run UUID, extra `io.pi-worktree.role=git`.
- Explicit host `recover-git` gets repo lock nonblocking and only stops/removes a recognized helper by ID; never a task container. A live owner holding the mutex prevents recovery.
- Actual Docker bind semantics (especially `git worktree add` into the precreated mounted directory) still need real smoke validation.

`src/host/container-cleanup.ts` extracts existing ownership/cleanup code, supports helper name/role. Original task behavior preserved.
`docker-client.ts` now accepts helper-name lookup and has `capture(id, signal)` (120s bound) for worker JSON; create/start separated, cleanup still handles cancellation/unknown replies safely.

### 3. Worktree service, live listing, new tabs and host commands

New `src/host/worktrees.ts`:
- `createWorktreeService(config, sourcePath, docker, options)` handles all FOUR existing v1 operations. Validates request then serializes under repo operation lock.
- List/inspect re-read Git metadata and use isolated helpers for snapshots. Expose Git locked/prunable reasons. Unauthorized/missing/corrupt entries become `inspection: unavailable`, never invented clean. A Docker leftover without runtime lock is unavailable with host recovery instructions.
- Open: inspect/revalidate; already active returns without any Kitty command/focus. Closed dirty/conflicted worktrees can reopen. Missing/unauthorized/unavailable cases refused.
- Create-or-open: validate literal branch before mutation, reuse existing linked worktree, attach existing branches without overwriting upstream, otherwise new local-parent branch at source HEAD. Predictable slug+hash destination; occupied paths fail without overwriting. Host creates empty destination, helper creates Git worktree, then launches new tab. Any failure preserves branch/worktree/empty slot for explicit inspection; no destructive retry/cleanup.
- Repo mutex stays held through Kitty launch handoff until new supervisor lifetime lock is observed (15s deadline). This avoids cooperative duplicate launch races without a task registry. Timeout means startup outcome unconfirmed; don't auto-retry.
- Options `helper`/`launch`/user are trusted test adapters, not config/protocol capabilities.

New `src/host/kitty.ts`:
- Only fixed `kitty @ --to unix:<hostSocket> launch --type=tab --keep-focus --hold --cwd <authorized> --title <safe starting title> <node> <installed CLI> start --config <trusted file>`.
- No existing-tab match/focus/colors commands, no arbitrary executable/Kitty target from requests, no shell, no tab-title override (window title must remain Pi-updatable).
- `kittySocket` new optional host config field; otherwise use host `KITTY_LISTEN_ON` only for filesystem Unix addresses. Canonical owned socket/executable outside task mounts required. Default executable `/usr/bin/kitty`; test seam only for fake executable.
- Fixed CLI path selects `.ts` under native source execution and `.js` under compiled installation.

New `src/host/commands.ts`:
- Host `list` (human-safe table or --json), `open <branch|unique ID prefix>`, `recover-git`. Config explicitly selects repo, so list/open can work after all managed tabs close.
- Selection is matched against live Git, then converted to full opaque ID, never a user-supplied path.
- Uses its own private Docker control directory, signal cancellation and awaits service completion BEFORE deleting control dir (important async finally lifetime).

Existing changes:
- `git-discovery.ts` exports authorized location/list helpers and a fixed read-only `show-ref` branch-existence lookup. Host reader still MUST NOT run status/checkout/merge/worktree-add or general Git commands.
- `supervisor.ts` now wires real worktree service, accepts trusted configPath option, and refuses startup while a repo Git helper exists (active or orphan; wait/recover-git).
- `cli.ts` supports list/open/recover-git in addition to inspect/start/recover. Passes configPath to supervisor. No TTY needed for host list/open; start still requires one.
- `config.ts` optional kittySocket, protected from task mounts.
- `docker.ts` passes `PI_WORKTREE_ROOT`, `PI_WORKTREE_GIT_DIR`, `PI_WORKTREE_COMMON_GIT_DIR` in addition to private socket. These are harmless fixed mount identities, not Docker/Kitty capabilities.

### 4. Pi extension implemented

`src/extension/index.ts` now registers exactly five USER commands, never tools/LLM prompts:
- `/worktree <name>` -> narrow create-or-open; keep current session.
- `/worktrees` -> live host list, built-in `ctx.ui.select`, open selected ID. Cancel does nothing. Rendered rows include path, target/upstream, abbreviated head, open/closed/status/locked/prunable. Sanitize display text.
- `/worktree-done` -> shared backend clean check, transient done title, no persistence/testing.
- `/worktree-sync` -> shared merge-based sync, conflict title and instructions to resolve here, no target changes.
- `/worktree-merge <name>` -> select unique task from host list, pass fresh host inspect callback into shared ff-only integration backend.

Details:
- No factory-time I/O/background resources, no appendEntry/sendUserMessage/registerTool, no persistent done state.
- Default local Git adapter requires supervisor mount env + matching ctx.cwd; refuses standalone host Pi execution of these Git operations.
- Commands serialized in memory (not dropped/rate-limited); Git commands require ctx.isIdle. No effects in headless mode.
- Session startup derives state (otherwise attention); agent_start -> working; **agent_settled**, not agent_end, -> derived idle/conflict/merged state. Generation counter prevents stale startup read overriding working state.
- Session shutdown aborts work and waits command tail; late replies suppressed. Errors sanitized; failed title on command errors. Done resets on next agent/session lifecycle, never persisted.
- Socket request timeout set to 10 minutes for potentially large live lists; no automatic retries.
- Test adapter `installWorktreeExtension(pi, deps)` allows real/mock backends without adding runtime dependencies.

### 5. Kitty rendering and image files

New `kitty/tab_bar.py`: fixed marker/state palette, renders remainder literally via screen.draw, strips controls/bidi, clips by Kitty wcswidth, restores cursor colors, no title template/eval. Pure parser plus draw adapter.
New `kitty/kitty.conf.example`: socket-only remote control, private Unix listen_on under XDG_RUNTIME_DIR, custom tab bar. **Copy trusted script outside mounted checkouts; do not symlink to task-writable code.** Kitty may suffix socket with PID; host KITTY_LISTEN_ON has actual address.

`container/Dockerfile` now copies compiled `dist/git` for worker/backend.
New `container/Base.Dockerfile`: OPTIONAL reference base (Node 24 bookworm-slim, bash/CA/git/rg, pinned Pi 0.84.4). Existing overlay still requires explicit PI_BASE_IMAGE; this is not assumed to match user's old image. No builds performed.

## Tests added/changed and latest results

New:
- `test/git-operations.test.ts`: 10 real-Git tests for status precedence, feature/nested creation, preserved existing upstream, done preconditions, sync conflict preservation/resolution, ff-only target invariants, dirty/racing task rejection, clean sync, deleted/renamed/remote/ambiguous/revision-like upstreams, submodule/callback rejection, hooks/filters not executed.
- `test/worktree-service.test.ts`: 7 integration tests using real worker via fake Docker and OS lock stand-in for Kitty startup. Feature/nested source, dirty source not copied, live reopen/active no-focus, duplicate creation serialization, locked/prunable/outside paths, collisions, Kitty failure preservation, helper mount constraints.
- `test/extension.test.ts`: 9 Pi API tests, commands/lifecycle/cancellation/serialization constraints, no LLM/persistence, UI sanitation/no headless effects, idle gate, fresh task inspect callback, standalone host Git refusal.
- `test/title.test.ts`, `test/kitty.test.ts`: title contract and safe argv/verified host resources using fake Kitty executable.
- `test/kitty-tab-bar.test.py`: Python parser/width/color tests with mocked Kitty modules. `test/kitty-python.test.ts` runs them if python3 exists; **skipped here**.

Existing fake Docker CLI now recognizes git-role helpers and calls production worker on TEMPORARY test repos without Docker isolation. This is test-only, not a production host fallback. The supervisor's existing request-service test now expects a real list, not unavailable.

Last full command before pause: `npm run check` -> 181 total / **180 passed / 1 Python skip**, typecheck/build passed, ~37s. No non-root repeat of NEW feature suite or compiled end-to-end feature test was done yet. Previous Phase 3c non-root/lifecycle checks are historical, not proof of all these new features.

## Remaining work when user resumes

1. **Review/harden new code before declaring completion.** Especially helper cancellation/orphan/name collision/recovery and startup guard, launch handoff timeouts, mount validation/revalidation, local Git config callbacks, status/upstream edge cases and command/UI error semantics. Basic tests pass, but code is new/unreviewed.
2. Add tests for **orphan Git helper detection/recover-git and active repo mutex refusal**, helper create/capture failure/cancellation paths, host list/open CLI selection. Existing task-container recovery tests remain, but helper-specific recovery coverage is incomplete.
3. Add opt-in real Docker smoke tests (not written yet), with fresh test-only volume/repos: persistence across --rm containers, stable paths, UID/GID, private socket reachability, absence of Docker/Kitty sockets, common .git mount-point protection, helper creation into preallocated bind. Do NOT use real credentials or claim OAuth tested. Actual image/login/Kitty/TTY checks need user's host.
4. Run full tests again, non-root feature/lifecycle subset, compiled-module/extension load checks. Run Python renderer tests where Python is available. No Python/Kitty render validation performed here.
5. **Update user docs**: README.md, docs/host.md, docs/protocol.md, container/README.md, kitty/README.md are stale (mostly Phase 3c). Explain current commands, list/open/recover-git, helper security/locks/orphans, one-time image + persistent auth + trusted host copy + Kitty install/alias workflow, local-upstream push warning, sync/conflict/ff flow, no project tests, unsupported submodules/sequencers/filter semantics, non-atomic concurrent-edit caveat and deployment checks. Include reference-base workflow, safe release install OUTSIDE task mounts and copied tab_bar.py.
6. Update plan progress/acceptance notes and this handoff. Earlier user request was to finish rest without intermediate review, but **wait for a resume instruction now**.

## Invariants from previous phases to preserve

- Git provides persistent task state; no registry/db, no persisted done/test result state. No forced Git cleanup, branch deletion, worktree deletion, automatic commits (except Git's merge-based sync commit), conflict resolution, user project checks or service provisioning.
- Task runtime: explicit stopped Docker create then verified attached start; no managed --rm. Scope labels + full ID only for cleanup; same daemon/runtime root across sessions. API uncertainty retains locks/retries. SIGKILL may leave container; next start refuses name and host recover verifies labels/lock before stop/remove. Keep lock until container removal AND request handlers settle. Don't sweep other tabs' runtime dirs or unlink lock files.
- Runtime dirs canonical UID-owned 0700, socket/lock files 0600; Linux util-linux flock retains parent file description after utility exits. Empty lock files aren't a task registry. Keep handles reachable and avoid accidental child inheritance.
- Host config private, explicit, frozen, strict keys; main checkout normal .git directory; dedicated sibling task root, immediate children. Host code/deps/config/Node/Docker/Kitty/sockets/runtime outside all task mounts. No bare/separate-Git/nested repo support in initial host policy. Don't move active worktree directories or switch daemon/runtime root while sessions survive.
- Common Git ALWAYS separately bind-mounted even within main checkout, so containers can't replace its root with a symlink. Task-root parent never mounted. Checks don't constitute a sandbox against arbitrary hostile HOST filesystem edits.
- Protocol v1 unchanged: create-or-open(branch), list, open(ID), inspect(ID), strict fields; no arbitrary paths/source branches/commands/image/options/Kitty targets. IDs hash canonical paths, not secrets; reauthorize live Git each request. uint32 BE + UTF-8 JSON, one request/response with EOF validation, 16 KiB request / 1 MiB response, no count/rate limits, explicit response-too-large. Client cancellation/timeout is not rollback proof.
- Pi image extension is explicit and outside shared agent volume. Fixed /pi/agent RW named volume; no credentials baked in. All task containers can read credentials/shared settings. Don't share with trusted host Pi. Stable per-worktree session directory hash avoids default Pi path-encoding collisions; no automatic old-session migration. New Pi session only flushes after first assistant message in 0.84.4.

## Reference reading done this session

Read installed Pi `docs/extensions.md` COMPLETELY (all 3,021 lines), `docs/tui.md` COMPLETELY, and examples `titlebar-spinner.ts` and `commands.ts`. Used built-in select/UI APIs, no custom TUI dependency. Previous phases read containerization/environment/settings/sessions/session-format/providers; relevant auth/session implementation.

Fetched/read relevant Kitty upstream API source through Node fetch: tab_bar.py (drawing API), rc/launch.py, and options/definition.py sections for socket-only/listen_on. Confirmed env expansion and automatic PID suffix, and socket-only denies TTY remote control. Temporary reference files are `/tmp/pi-worktree-tab_bar.py`, `/tmp/pi-worktree-launch.py`, `/tmp/pi-worktree-kitty-options.py`; these may disappear. No third-party source copied into production; custom renderer is original code using public APIs.

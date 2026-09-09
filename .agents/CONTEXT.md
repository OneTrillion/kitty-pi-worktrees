# Implementation handoff — plan implementation finished; deployment verification pending

## Current status

- User resumed implementation after the earlier pause and asked to implement the whole plan. **The old pause is no longer active.** Source Phases 1–8 and remaining automated hardening/docs work are now implemented. Do not confuse source completion with actual deployment acceptance.
- Plan: `.agents/plans/IMPLEMENTATION_PLAN.md`, now with a status/acceptance table. AI-only notes remain under `.agents/`; user docs in README/docs/container/kitty.
- Started this resume clean at **`27b6503` (`lots of shit`)**, which already contains the previous session's feature work. This session's changes are **uncommitted**. No assistant commits. Use `git -c safe.directory=/workspace ...`; no global safe.directory changes.
- Node **24+**, Zod only runtime dependency; TypeScript, Node types and Pi 0.84.4 dev dependencies. No new dependencies.
- All five Pi user commands, four socket operations, host inspect/start/list/open/recover/recover-git, Git backend/helpers, Kitty rendering and image integration exist.
- **Still pending on the user's host:** real image builds, Docker mounts/UID/PTY validation, Kitty renderer/socket-only/manual workflow, `/login`/OAuth refresh and real session resume. Existing user Dockerfile/image, old alias and host setup have not been supplied. Supported host policy remains Linux. Do not claim the manual acceptance criteria passed.

## Validation this resume

- Current `/workspace` source suite: **196 tests, 195 passed, 1 Python skip, 0 failures**. Typecheck passed.
- Same complete source suite as non-root `node` user: **195 passed, 1 Python skip** using `runuser -u node -- env PATH=/usr/local/bin:/usr/bin:/bin npm test`.
- `npm run check` now includes source tests, build, and `node --test test/compiled-smoke.ts`. In a writable temporary copy: **full check passed** (195 source passes + 1 compiled smoke pass; 1 Python skip).
- Separate non-root writable copy: typecheck, build and compiled smoke also passed.
- **Environment gotchas:** `/workspace/dist` is a harness-provided read-only empty mount. In-place `npm run check` passes source tests but TypeScript emission fails with EROFS. Do not unmount/repair permissions or change the production build output to bypass this. Verified by copying src/test/kitty/container/docs/package files/tsconfig to `/tmp/pw-release-check-*`, symlinking the existing node_modules, then running the normal check there. Path recorded in `/tmp/pw-release-check-path`; logs `/tmp/pw-release-check.log`, `/tmp/pw-check.log`, `/tmp/pw-nonroot-clean.log`, `/tmp/pw-nonroot-build.log`. Temporary files may disappear later.
- Initial non-root test run inherited root's PATH `/root/.pi/agent/bin:...`, making missing `python3` produce EACCES instead of ENOENT. Clean PATH fixes that; no test failure was hidden by broadening skip conditions.
- **Docker, Kitty, Python3 and curl remain absent.** `npm run smoke:docker` reports its expected skip without `PW_DOCKER_SMOKE_IMAGE`; real Docker smoke was NOT executed. Python renderer tests are still unexecuted here.
- `git diff --check` passed. Build artifacts are not tracked.

## Changes made this resume

### Helper mount hardening

- New `src/host/mount-identity.ts`: `pinMountDirectories()` records canonical directory device/inode identities and returns a revalidator.
- Task supervisor refactored to reuse it (same behavior; private socket pin/revalidation still separate).
- Git helpers now authorize request location/destination against host policy, pin repository/task roots and selected worktree/Git/destination directories, and re-read Git location before create AND before starting the verified stopped helper. Observed mount replacement is refused and the stopped helper cleaned up before releasing the repository mutex. This closes a missing post-create check in previous feature work.
- These are observed-replacement checks, **not an atomic sandbox against hostile concurrent host filesystem edits**.

### Tests

- New `test/git-helper.test.ts` (12 tests): orphan blocks startup/reuse; scoped recover-git preserves other containers/files; live repo lock and wrong role refused; create failure/ambiguous reply/attach failure/bad worker JSON clean up; create-name collision doesn't remove foreign container; cancellation in capture, during create and while waiting for repo lock; uncertain cleanup retains mutex; post-create directory replacement never starts worker.
- Fake Docker worker adds `helperDelayMs` and `badHelperReply` controls (test only).
- New `test/host-commands.test.ts`: live branch/ID prefix selection, invalid paths/revisions and ambiguous selector refusal; real isolated inspection via fake Docker in list/open/recover-git; active no-refocus behavior; private control-dir lifetime and cleanup.
- `runHostCommand` has trusted optional Docker/service adapters for these tests. They are not CLI/config/protocol options.
- Worktree service test adds accepted-but-unconfirmed Kitty handoff: one launch, explicit uncertainty, preserved worktree.
- New `test/compiled-smoke.ts`, run AFTER build by `npm run check`: compiled CLI inspection, worker create/inspect in a temporary repo and compiled extension registration/lifecycle hook imports. No TypeScript source fallback for compiled modules.
- New opt-in `test/docker-smoke.ts` + `npm run smoke:docker`. Requires explicit already-built `PW_DOCKER_SMOKE_IMAGE`, optional `PW_DOCKER_SMOKE_SOCKET`, non-root deployment UID/GID. Fresh temporary repos and UUID-only volume/container names; no real credentials, Pi inference or Kitty. Verifies real helper create into preallocated bind, local upstream/read-only inspect, synthetic volume/session directory markers, stable cwd, UID/GID, private framed socket reachability, absence of host-control sockets/env, main `.git` EBUSY mount protection (linked parent may also refuse permissions), compiled extension load. Probe replaces Pi entrypoint with Node and uses --rm + network none; production helper uses real cleanup. Forced probe cleanup is scoped only to THIS test's UUID names, never a general prune. This script is typechecked but not executed against Docker here.

### Documentation

Replaced stale checkpoint docs with complete user-facing implementation docs:
- `README.md`: install links, commands, local parent/push warning, sync/conflict/ff workflow, persistence, status priority, limitations/security.
- `docs/host.md`: trusted release-copy installation OUTSIDE mounts, strict config incl. kittySocket, local Git identity, every host command, startup/handoff/shutdown, task/helper recovery and detailed Git helper boundary.
- `docs/protocol.md`: all four handlers implemented; 10-minute extension timeout vs default client deadline, live status, helper/internal-schema distinction and recovery restrictions.
- `container/README.md`: existing image + optional reference base, persistent auth, worker image requirements, isolated helper mounts and opt-in smoke invocation.
- `kitty/README.md`: copy trusted renderer (no task symlink), socket-only config, actual PID-suffixed Unix socket selection, fixed title palette and manual validation.
- New `docs/validation.md`: automated vs real evidence, smoke capabilities/limits and detailed disposable-repo manual deployment acceptance checklist.
- Plan progress and this handoff updated. Source image/host remain same-revision release contract.

## Existing feature architecture / invariants to preserve

### Git/backend

- `src/git/operations.ts` runs only INSIDE task/helper containers or TEMP test repos; never general Git on host projects. Explicit worktree/Git/common paths and fresh env; hooks/fsmonitor/maintenance/GC/signing/editor callbacks suppressed, no remote/lazy fetch (`GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=""`, `GIT_NO_REPLACE_OBJECTS=1`).
- `prepare()` lists callback KEY NAMES using NUL `git config --name-only --get-regexp`, disables executable filters/processes and external merge drivers; refuses `=` or control/format chars in override keys. No project checks. Config can change concurrently; helper is the host execution boundary, not task self-protection.
- Status derives branch, committed head, local/remote upstream, dirty/untracked, conflicts/merge/rebase and priority live. Ref syntax checked before resolving upstreams. Missing/remote/ambiguous upstreams not guessed.
- Done is transient Git-only cleanliness check. Sync merges local parent in task, preserving conflicts. Integration fresh-inspects task through host, requires target ancestor and clean task/target, revalidates heads/parent, then ff-only merge of captured commit. No automatic task commits, branch deletion or worktree deletion; sync may create a normal Git merge commit.
- Submodules/gitlinks and active cherry-pick/revert/sequencer state refused for managed checks/integration. Filter-dependent/LFS files may appear dirty under disabled filters. Checks are snapshots, not locking out other agents/manual edits.

### Host/runtime/protocol

- Explicit stopped Docker create -> ID/ownership verification/revalidation -> attached start; no managed --rm. Full-ID scoped cleanup only. API uncertainty retains locks/retries; SIGKILL may leave a container; explicit host recovery checks name/labels/lock. Keep lock until removal AND request handlers settle. Never sweep another tab's runtime dir or unlink lock files.
- Linux util-linux flock keeps parent file description alive after utility exits. UID-owned canonical runtime directories 0700, sockets/locks 0600. Empty lock files aren't a task registry.
- Separate repository-operation OS mutex serializes live list/inspect/create/open through helper cleanup and launch handoff. One deterministic `pi-worktree-git-<commonGitHash>` helper name per repo guards owner death. Helper role label = git. recover-git never touches task containers.
- Host config explicit/frozen/strict, normal main `.git` directory and dedicated separate task root with immediate children only. Host code/deps/config/Node/Docker/Kitty/sockets/runtime outside all task mounts. Common Git ALWAYS separately bound even in main checkout; task-root parent never mounted. No bare/separate-Git/nested host repo policy. Do not move active paths or switch daemon/runtime roots while processes survive.
- Host discovery only fixed read-only Git builtins; status/add/checkout/merge must stay in containers. Helper inspection RO worktree/common Git; creation RW preallocated destination/common Git ONLY. No auth volume or any control socket; helper network none/read-only rootfs/caps dropped/non-root.
- v1 protocol unchanged: create-or-open(branch), list, open(ID), inspect(ID). Never paths/source/image/options/commands/Kitty IDs. IDs hash canonical path, reauthorized live, not secrets. uint32-BE + UTF8 JSON, one request/response validated at EOF, 16 KiB request / 1 MiB response, explicit response-too-large, no count/rate limits. Client timeout/cancel is not proof of rollback.
- Fixed Kitty argv launches a NEW tab with `--keep-focus --hold`; no existing-tab commands, shell, title templates or tab-title override. Actual Unix Kitty address from trusted config or host KITTY_LISTEN_ON; never passed to task.

### Pi/image

- Five USER commands only, no LLM tools/prompts/persistent entries. Built-in select, sanitized UI. Commands serialize in memory; Git commands idle-gated; no headless effects; shutdown aborts/waits command tail. Default backend requires supervisor env/matching cwd, refuses standalone host Pi Git work.
- Lifecycle uses agent_settled, NOT agent_end; generation guards prevent stale startup state overwriting working. Done resets later, never persisted.
- `/pi/agent` shared RW named volume, built-in extension outside it. Every task can read credentials and modify shared settings/Git; do not share with trusted host Pi. No auth baked in. Pi auth update locking is upstream.
- Stable session directory is `/pi/agent/sessions/<canonical-path-hash>` to avoid Pi default slash/dash collisions; --continue. No automatic migration of old alias sessions. New Pi 0.84.4 session flushes only after first assistant message.

## Next steps

No known source feature remains from the plan. Before claiming acceptance, run `docs/validation.md` with the user's actual Linux/Docker/Kitty setup, reference or existing image and non-root UID/GID. In particular, validate real helper bind semantics, Python/Kitty API behavior, socket-only denial, close-tab cleanup, one-time login persistence and distinct real session resume. Fix any deployment findings without weakening the host capability boundary. No Docker/Python/Kitty/OAuth success can be inferred from fake tests.

## Reference reading

Previous feature session read all Pi extensions.md (3021 lines at that time), tui.md, titlebar-spinner.ts and commands.ts examples; upstream Kitty tab_bar.py/rc launch/options were fetched and reviewed. This resume read installed Pi docs containerization.md, environment-variables.md, providers.md, sessions.md and the related settings.md/session-format.md completely for deployment/persistence documentation. No extension API behavior was changed this resume.

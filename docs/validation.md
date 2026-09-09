# Validation and deployment acceptance

## Automated checks

```sh
npm ci --ignore-scripts
npm run check
```

The default suite tests real temporary Git repositories (including feature/nested parents, dirty/untracked work, conflicts, callback suppression and ff-only integration), strict framing/protocol rejection, path authorization, OS locks and signals, Pi API command/lifecycle mocks, persistence with synthetic credentials, and fake Docker/Kitty CLI boundaries. Helper tests cover cancellation, ambiguous creation, ownership collisions, mount replacement, cleanup uncertainty, orphan detection and explicit recovery. No user project tests or services are invoked.

Python parser/width/color tests run if `python3` is available; otherwise the runner reports a skip. Run `python3 test/kitty-tab-bar.test.py` explicitly on a host with Python. This mocks the Kitty screen API, not the actual terminal.

Run the suite as a **non-root user** too. Filesystem ownership and Unix socket permission tests are meaningful only with the intended deployment UID. The root test run uses explicit non-root Docker-user adapters, not actual container UID mapping.

## Opt-in real Docker smoke test

First build an integrated image for your actual non-root UID/GID; see [container setup](../container/README.md). Then:

```sh
PW_DOCKER_SMOKE_IMAGE=pi-worktree:local npm run smoke:docker
# If required, also set PW_DOCKER_SMOKE_SOCKET to a local Unix socket path.
```

With no image variable, the test reports a skip. It never builds/pulls an image, calls a model, logs in, or uses your normal agent volume. It creates **fresh test-only repositories and a UUID-named volume**, then checks:

- Real credential-free helper creation into a preallocated bind-mounted destination, followed by read-only Git inspection and local upstream verification.
- Stable absolute cwd and separate per-worktree session-directory markers.
- Synthetic agent-volume data persists through repeated `--rm` containers.
- Non-root UID/GID matches the host and files remain writable/host-owned.
- The private mounted supervisor socket is reachable using the real framed client.
- Standard/configured Docker socket paths, the original host supervisor path and host Docker/Kitty control variables are absent.
- The separately mounted common `.git` root cannot be renamed from inside either main or linked worktrees.
- The compiled extension loads and registers its five commands in the image.

The task probe deliberately replaces Pi's entrypoint with Node and disables network. It does **not** prove the Pi TUI, OAuth, actual session resume or Kitty behavior. The normal supervised task entrypoint and network policy are separately tested via argv/entrypoint tests and the manual checks below. Probe cleanup only targets names created by that test; it never prunes other Docker resources. If the test process is killed or the daemon is unavailable, inspect any `pi-worktree-smoke-*` resources and temporary `pw-git-*` paths before manually removing them. Never use a blanket container/volume prune as recovery.

Docker Desktop, rootless/user namespaces, SELinux labeling and nonstandard socket/mount layouts are not silently worked around with privileged mode or extra host mounts. A failing smoke test means investigate that deployment before using the launcher.

## Manual Kitty and Pi checks

Use a disposable repository and a separate test agent volume first. Record your OS, Docker/Kitty/Git/Node versions, image revision and UID/GID mapping. No actual Docker/Kitty/OAuth checks have been completed in the development environment (those executables are absent).

1. **Image/login:** build your existing image plus overlay (or reference base). Run the auth-only container, `/login`, exit, recreate it with the same volume, and verify authentication remains. Use a provider-supported pasted redirect/code flow if needed. Never mount host control sockets or use host networking to bypass login issues.
2. **Launch/resume:** install trusted host code and copied Kitty renderer outside the test mounts. Start via the revised alias in the main worktree. Submit a message and wait for an assistant response so a new Pi session is flushed; inspect `/session`. Close/reopen and verify the expected transcript resumes. `/new` should create a separate session within that same worktree's session directory. Unsaved editor text is not promised persistence.
3. **Feature/nesting:** from `feature/payments`, run `/worktree payment-tests`, then `/worktree payment-docs` in the new task. Verify local upstreams and committed starting points with Git. The original sessions stay open and focus does not change automatically. Dirty source files are not copied.
4. **Listing/reopen:** use `/worktrees`, cancel, select a closed dirty worktree, then select an already-open one. Confirm only the closed one creates a new tab. Close all managed tabs and use host `list`/`open` with the same config. Both worktrees should share authentication but resume separate saved sessions.
5. **Title/rendering:** exercise starting, working, attention, done, conflict, merged and command-error/failed states. Try long/Unicode names and normal non-Pi tabs. Ensure literal text rendering, correct clipping and no stale `done` after agent activity or reopening. Idle should follow `agent_settled`; retries must not prematurely mark idle.
6. **Socket boundary:** check container mounts and environment from the host's `docker inspect`; only prescribed project/Git/agent/private-socket mounts should appear. In the container, connecting to Docker/Kitty host sockets must fail because they are absent. Attempt Kitty remote control via the terminal channel (for example `kitty @ ls` if the trusted image happens to contain Kitty) and confirm socket-only policy refuses it. Do not enable terminal remote control as a workaround. Changing the container's own title should not affect another tab.
7. **Done/sync/ff:** verify dirty/untracked work and active merges are refused by `/worktree-done`. Commit in a task, independently advance the parent, and verify target `/worktree-merge` refuses non-ff without changing target files or HEAD. `/worktree-sync` should merge in the task; intentionally conflicting changes remain there. Resolve/commit there, then integrate from the target. Confirm no tests, hooks, services or automatic deletion occurred.
8. **Shutdown/recovery:** close one tab and confirm its container disappears, the other continues, and dirty files/sessions survive. Exercise normal exit, HUP/TERM and terminal restoration. In this disposable setup only, kill one supervisor uncatchably and verify a second `start` refuses the leftover until host `recover` acquires the lock and verifies/removes it. Test `recover-git` only for a verified orphan helper; it must refuse a live repository operation. Never delete lock files to bypass refusal.
9. **Upstream errors:** delete/rename the parent or replace tracking with a remote ref in the disposable repo. Lists should show live status and sync/integration should explain missing/nonlocal parents, not guess. Repair explicitly with local Git branch tracking.
10. **Cleanup:** close every test tab, verify no task/helper writers remain, then remove disposable worktrees/branches with non-forced Git commands. Remove only the dedicated test credential volume when no longer needed. Never delete the real agent volume as part of worktree cleanup.

The source implementation and simulated tests are not a substitute for these deployment acceptance checks. The existing user image, old alias and actual deployment host have not yet been supplied; adapting those remains a deployment step rather than an assumed tested workflow.

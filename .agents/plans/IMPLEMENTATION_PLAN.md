# Pi Worktree Extension — Implementation Plan

## Implementation status (latest resume)

Source implementation for Phases 1–8 is complete, including hardening, recovery tests, opt-in Docker smoke coverage and user documentation. **Deployment acceptance is not yet complete.** The user's existing image/alias and actual host setup have not been supplied, and this environment has no Docker, Kitty or Python executables.

| Phase | Implementation / automated evidence | Remaining deployment verification |
| --- | --- | --- |
| 1 | TypeScript build, strict protocol, branch/path validation | None specific |
| 2 | Image overlay/reference base, stable session dirs, synthetic Pi auth/session persistence tests | Real image build, `/login`/OAuth refresh, concurrent auth and actual resume |
| 3 | Linux supervisor, private sockets/locks, stopped create + verified start/cleanup/recovery | Real Docker UID/mount/PTY/tab-close behavior |
| 4 | Isolated worktree creation, local parents, live reuse, fixed Kitty new-tab launch | Real helper bind semantics and Kitty handoff |
| 5 | Live list/selector, host list/open, task/helper orphan recovery | End-user abrupt tab shutdown and resume |
| 6 | Pi lifecycle titles and trusted literal Kitty renderer | Python renderer tests and actual Kitty socket-only/rendering checks |
| 7 | Git-only done, merge sync, ff-only integration; real-Git conflict and target-invariant tests | Exercise interactive user workflow |
| 8 | Mount-identity hardening, helper failure/cancellation/ownership tests, CLI selectors, compiled smoke, complete setup/recovery/security docs | Run `docs/validation.md` on the deployment host |

Latest checks: default suite **196 tests: 195 passed, 1 Python skip** as both root and non-root. Typecheck/build and **1 additional compiled CLI/worker/extension smoke test passed** in writable temporary copies (also as non-root). `/workspace/dist` is a harness-provided read-only mount, so an in-place `npm run check` passed source tests but could not write build output; no mount/permissions workaround was applied to the checkout. `npm run smoke:docker` correctly skips without an explicit image; real Docker smoke assertions are implemented but unexecuted here.

See `.agents/CONTEXT.md` for implementation/revalidation details and `docs/validation.md` for remaining acceptance checks. No assistant commits were made.

## 1. Objective

Build a small system for running multiple independent, interactive Pi sessions against Git worktrees, with one Docker container and one Kitty tab per worktree.

The implementation must prioritize a small surface area and rely on Git wherever possible. It must not introduce a persistent task registry or database.

## 2. Final design decisions

- Pi runs inside Docker.
- The Pi extension is built into the existing Pi image; it is not installed separately with `pi install`.
- The existing host alias is changed to invoke a host launcher/supervisor instead of invoking Docker directly.
- Every Kitty tab has its own host supervisor and one attached task container.
- `/worktree <name>` can create or reopen a worktree without closing the current Pi session.
- `/worktrees` lists existing Git worktrees and can reopen a closed one.
- Worktrees may be created from any local branch, including feature branches.
- A newly created task branch uses its source branch as its local Git upstream. The upstream is the integration target.
- Git is the source of truth for worktree paths, branches, upstreams, commits, conflicts, and merge state.
- There is no persistent extension-specific task registry.
- “Done” is transient UI state; it is not persisted after the tab closes.
- The extension does not run or verify project tests, linting, databases, CI, or other project-specific checks.
- Kitty remote control is available only on the host and configured as socket-only.
- The Kitty socket and Docker socket are never mounted into task containers.
- Containers may request worktree creation/opening without confirmation, limits, or rate limiting.
- The host request protocol is narrow and does not accept arbitrary commands, paths, Docker options, or Kitty targets.

## 3. Non-goals

The initial implementation will not provide:

- Subagents or autonomous task delegation
- A global controller package or permanent daemon
- A task database or JSON registry
- Test execution or test-result tracking
- CI integration
- Database/service provisioning
- Automatic commits
- Automatic conflict resolution
- Automatic worktree deletion
- Automatic branch deletion
- Automatic focusing or modification of existing Kitty tabs
- Direct container access to Docker or Kitty
- General-purpose host command execution
- Support for multiple containers editing the same worktree

## 4. High-level architecture

```text
Kitty
├── trusted custom tab bar
└── one tab per worktree
    └── host launcher/supervisor
        ├── holds the worktree runtime lock
        ├── exposes a private, narrow request socket
        ├── performs approved Git/Docker/Kitty operations
        └── runs one attached Docker container
            └── Pi
                └── worktree extension
```

The host supervisor is not a separate installed service. It is the process invoked by the existing Pi alias and remains alive while its child container is alive.

## 5. Repository layout

Plan for the project to contain:

- `src/extension/` — Pi extension
- `src/host/` — host launcher/supervisor
- `src/shared/` — request/response types and validation rules shared by host and extension
- `kitty/` — trusted custom tab-bar implementation and setup documentation
- `Dockerfile` or image integration files — build Pi and the extension into the image
- `test/` — tests for this project’s Git, protocol, and launcher behavior
- `README.md` — installation, security model, commands, and workflow

Use Node.js 24+ and keep dependencies minimal. AI-only plans and handoff notes belong under `.agents/`; user/contributor documentation remains with the project. The host launcher and extension should be released from the same source revision so their protocol remains compatible.

## 6. Host launcher/supervisor

### 6.1 Startup responsibilities

When invoked from a Git worktree, the host launcher will:

1. Resolve the current worktree root.
2. Resolve the common Git directory.
3. Resolve the current local branch.
4. Refuse startup outside a Git worktree.
5. Create a private runtime directory and Unix socket for this tab.
6. Acquire an advisory host lock for the canonical worktree path.
7. Refuse to start a second container when the same worktree lock is held.
8. Start Docker as an attached child process with inherited terminal input/output.
9. Continue serving requests while Docker is running.
10. Forward termination appropriately to Docker.
11. Remove the private socket and release the lock on exit.

### 6.2 Docker launch responsibilities

The launcher will determine Docker behavior entirely from trusted host configuration. Requests from the container cannot override it.

Each container will receive:

- The selected worktree mounted read/write
- The common Git directory mounted at the path expected by the worktree’s `.git` pointer
- A stable working directory matching the worktree identity
- The shared persistent Pi agent volume
- The private supervisor request socket
- Harmless task metadata such as the current branch name
- The fixed image and fixed Docker options selected by the host launcher

Each container will not receive:

- The Docker socket
- The Kitty remote-control socket
- Arbitrary host directories
- Host commands or executable paths supplied by a request

Run the container as the host user’s UID/GID where practical so worktree files do not become root-owned.

### 6.3 Stable paths

A worktree must use the same effective working directory whenever it is reopened so Pi can find the correct previous sessions for that directory.

The preferred mounting strategy is to preserve the worktree’s host absolute path inside the container and mount the common Git directory at the same absolute path expected by Git. Avoid mounting every worktree as the generic `/workspace` path.

### 6.4 Request protocol

Use a versioned, length-limited protocol over a private Unix socket. The initial operation set is:

- Create or open a worktree by branch/task name
- List linked worktrees and their derived status
- Open an existing linked worktree
- Inspect whether a linked worktree is currently open or dirty

The host must reject:

- Unknown operations
- Absolute paths
- Relative traversal such as `..`
- Invalid Git branch names
- Embedded shell syntax
- Image names, Docker arguments, mount definitions, or commands
- Kitty window or tab identifiers supplied by the container

The host will invoke Git, Docker, and Kitty through argument arrays rather than shell command strings.

There will be no confirmation prompt, request count limit, or rate limit. It is an accepted trade-off that code in a task container can repeatedly request valid new worktrees and task containers. The protocol must still prevent arbitrary host execution or control of existing Kitty windows.

## 7. Git model

### 7.1 Source of truth

Use `git worktree` data and normal branch data for all persistent state.

Git will provide:

- Linked worktree paths
- Checked-out branches
- Current commits
- Locked/prunable state
- Dirty/untracked state
- Active merge or rebase state
- Unresolved conflicts
- Ahead/behind relationships
- Whether one branch contains another

No application registry will duplicate this information.

### 7.2 Creating a worktree

When `/worktree feature1` is invoked from a worktree currently on `feature/payments`:

1. Treat `feature1` as the requested local branch name.
2. Validate it using Git’s branch-name rules.
3. If the branch does not exist, create it at the current `feature/payments` HEAD.
4. Set the new branch’s local upstream to `feature/payments`.
5. Create a linked worktree under the configured worktree root.
6. Open the new worktree in a new Kitty tab using another host supervisor.

The source branch may be `main`, a feature branch, or another task branch. Detached-HEAD creation will be rejected in the initial version because there is no stable local target branch to record as an upstream.

Uncommitted changes from the source worktree are not copied into the new worktree.

### 7.3 Existing branches and worktrees

For `/worktree <name>`:

- If no local branch exists, create it from the current branch and set its local upstream.
- If the local branch exists but has no linked worktree, attach a new worktree without replacing its existing upstream configuration.
- If a linked worktree exists and is closed, reopen it.
- If the linked worktree is already open, report that fact and do not focus or alter its existing tab.
- If the requested branch is already checked out in an incompatible state, report the Git error without forcing it.

### 7.4 Worktree paths

Use a predictable worktree root selected by the host launcher. Derive a filesystem-safe directory name from the full branch name and handle collisions deterministically.

The path is discoverable later through `git worktree list`; no separate name-to-path mapping is needed.

### 7.5 Upstream semantics

A managed task branch’s local upstream is its integration target.

This supports arbitrary nesting:

```text
main
└── feature/payments
    └── feature1
        └── feature1-docs
```

The implementation must clearly document that running a push operation which replaces the task branch’s upstream with a remote branch will remove this parent relationship. Pushing a managed task branch should not use behavior that replaces its local upstream.

If an upstream is missing or points to a remote task branch, sync/integration commands must stop and explain the problem rather than guessing a target.

## 8. Pi extension commands

### 8.1 `/worktree <name>`

- Send a create-or-open request to the current host supervisor.
- Keep the current Pi session open.
- Report whether the worktree was created, reopened, or already active.
- Do not send this command to the LLM.

### 8.2 `/worktrees`

- Request the linked-worktree list from the host.
- Derive status from live Git information.
- Display an interactive selector in Pi.
- Open a selected closed worktree in a new Kitty tab.
- Report an already-open worktree without focusing or modifying its tab.

Suggested displayed fields:

- Branch
- Worktree path
- Local upstream/target
- Current commit abbreviation
- Open or closed
- Clean, dirty, conflict, needs-sync, ahead, merged, or upstream-gone

### 8.3 `/worktree-done`

This is a lightweight, user-declared completion action.

It will perform Git-only checks:

- Reject an active merge or rebase.
- Reject unresolved conflicts.
- Reject modified or untracked files so the result is fully represented by commits.

It will not run tests, linting, type checks, databases, CI, builds, or project commands.

On success, change the current tab’s title state to `done`. This state is intentionally transient. After the tab closes and reopens, the user may run `/worktree-done` again.

### 8.4 `/worktree-sync`

- Require a clean current worktree.
- Resolve the current branch’s local upstream.
- Merge the upstream branch into the current task branch.
- If Git reports conflicts, leave them in the task worktree and set the tab state to `conflict`.
- Do not attempt automatic conflict resolution.
- Let the user ask the current Pi session to resolve conflicts manually.

Use merge-based synchronization for the initial version. Do not implement rebase-based synchronization initially.

### 8.5 `/worktree-merge <name>`

Run this from the target branch’s tab.

- Resolve the selected task branch.
- Verify that the selected task branch’s local upstream is the current branch.
- Ask the host supervisor to inspect the selected worktree and verify it has no uncommitted or untracked changes.
- Verify that the current target worktree is clean and conflict-free.
- Require the current target branch to be an ancestor of the task branch.
- Update the target using fast-forward-only behavior.
- If fast-forward is impossible, leave the target unchanged and instruct the user to run `/worktree-sync` in the task tab.
- Do not run project tests.

This keeps conflict resolution in the task worktree rather than leaving the target worktree partially merged.

### 8.6 Cleanup

Automatic cleanup is out of scope for the first implementation.

Closing a tab stops its container but preserves the worktree and branch. Worktree and branch removal remain explicit host-side Git operations initially. A later command may wrap non-forced Git cleanup, but it must never remove dirty or unmerged work.

## 9. Listing and status derivation

Derive status each time `/worktrees` is opened; do not cache persistent task state.

Use these rules in priority order:

1. `conflict` — unresolved files or merge/rebase operation present
2. `dirty` — modified or untracked files present
3. `upstream-gone` — configured upstream no longer resolves
4. `merged` — task HEAD is reachable from its upstream
5. `needs-sync` — upstream HEAD is not reachable from task HEAD
6. `ahead` — task is clean, contains upstream, and has additional commits
7. `clean` — clean without another more specific state

Open/closed is determined independently from the host runtime lock.

Git does not distinguish an intentionally closed dirty worktree from one interrupted by closing Kitty. Both are shown as closed and dirty.

## 10. Closing and reopening tabs

### 10.1 Closing

When Kitty closes a task tab:

- The attached Docker process is stopped.
- The supervisor socket is removed.
- The runtime lock is released.
- The linked Git worktree remains untouched.
- The branch and all committed/uncommitted changes remain.
- Pi session files remain in the persistent Pi agent volume.

A submitted Pi message is persisted normally. Text typed but not submitted may be lost. An abruptly interrupted tool or shell command may leave partial filesystem changes, which will appear as normal Git dirty/conflict state on reopening.

### 10.2 Reopening from the host

The host launcher must provide a list/open mode so recovery remains possible when all Kitty tabs are closed.

It will:

1. Discover linked worktrees with Git.
2. Show their branch, path, upstream, and derived status.
3. Refuse worktrees whose runtime lock is held.
4. Open the selected worktree in a new Kitty tab.
5. Start the same image and shared Pi volume.
6. Continue the latest Pi session associated with that stable working directory.

### 10.3 Reopening from Pi

From any open Pi tab, `/worktrees` will use the same host discovery/open behavior through that tab’s private supervisor socket.

## 11. Kitty integration

### 11.1 Security configuration

- Configure Kitty remote control as socket-only.
- Keep the remote-control socket on the host.
- Do not bind-mount it into Docker.
- Do not pass its address or credentials into Docker.
- The trusted host launcher uses it only to create new tabs.

### 11.2 Status channel

The Pi extension reports state by setting its own terminal title through Pi’s UI API. Normal terminal-title output affects only the terminal window producing it and does not grant Kitty remote-control access.

Use a structured but human-readable title containing:

- A fixed extension marker
- State
- Branch/task name

The Kitty custom tab bar parses only the fixed state marker and maps it to predefined colors. It must treat the remaining title as plain text and never evaluate values supplied by the container.

Suggested states:

- `starting` — gray
- `working` — blue
- `attention` — amber
- `done` — green
- `conflict` — red
- `merged` — dim green or gray
- `failed` — red

### 11.3 Pi lifecycle mapping

- Session startup: derive initial Git state, otherwise `attention`
- `agent_start`: `working`
- `agent_settled`: `attention`
- Successful `/worktree-done`: `done`
- Sync conflict: `conflict`
- Fatal extension/container-visible error: `failed`
- Session shutdown: allow the shell/container lifecycle to replace or clear the title

Use `agent_settled`, not `agent_end`, for the idle transition because Pi may retry or compact after `agent_end`.

## 12. Authentication and Pi persistence

Use one persistent Docker volume for Pi’s agent directory and set a fixed `PI_CODING_AGENT_DIR` inside the image.

The shared directory contains:

- `auth.json`
- OAuth refresh tokens
- Pi settings
- Model configuration
- Pi sessions

Initial authentication flow:

1. Build the image.
2. Create the persistent Pi volume.
3. Start one container.
4. Run `/login` once.
5. Reuse the same volume in every later task container.

The volume must be read/write because OAuth credentials can refresh. Pi locks auth-file updates between concurrent processes.

Do not bake credentials into the image. Document that every task container can read the provider credentials available to Pi; protecting provider credentials from the entire container would require an external inference proxy and is outside this project’s initial scope.

## 13. Security model

### 13.1 Protected host capabilities

Task containers cannot directly:

- Run Docker commands on the host
- Access the Docker API
- Access Kitty remote control
- Select, focus, recolor, close, or execute commands in existing Kitty windows
- Execute arbitrary host commands through the supervisor
- Choose arbitrary host paths or container mounts

### 13.2 Intentionally exposed capabilities

Task containers can:

- Modify their mounted worktree
- Access the common Git metadata required by linked worktrees
- Read and update their shared Pi agent directory
- Request creation or opening of valid Git worktrees through the narrow supervisor protocol
- Cause the host to open a new Kitty tab running the predefined task container
- Change their own terminal title and therefore their own displayed tab state

Because requests do not require confirmation or limits, malicious code could repeatedly request valid worktrees and containers. This is accepted, but it must not be possible to turn the request fields into arbitrary host execution.

## 14. Error handling

All operations should fail safely and leave existing worktrees intact.

- Git command failure: return stderr in a concise Pi notification; do not retry destructively.
- Invalid branch name: reject before any filesystem or Kitty operation.
- Worktree path collision: stop and report it.
- Branch already checked out: report the existing worktree.
- Host socket unavailable: explain that Pi was not launched through the supervisor.
- Kitty launch failure: preserve the newly created worktree and report how to open it from the host.
- Docker launch failure: preserve the worktree; clean up any verified container before releasing the runtime lock. Creation and attached start are separate so an ambiguous create can leave only a stopped container.
- Docker cleanup uncertainty: retain the lock and retry until removal is confirmed. Supervised containers do not use Docker auto-remove; predictable names and ownership labels permit explicit recovery without a task registry.
- Sync conflict: preserve Git’s conflict state in the task worktree.
- Merge cannot fast-forward: leave the target branch unchanged.
- Abrupt supervisor death: rely on OS lock release and rediscover Git state next time, but do not assume the container stopped. A new start refuses an occupied container name. Explicit host-only `recover` must acquire the lock and verify ownership before stopping/removing a leftover by full container ID; it never changes worktrees, branches or named agent volumes.
- Corrupt or stale Git worktree metadata: expose Git’s prunable/repair information; do not force repair automatically.

## 15. Implementation phases

### Phase 1 — Project scaffolding

- Establish TypeScript/build structure for host, extension, and shared protocol.
- Define protocol version and strict request/response schemas.
- Add branch-name and filesystem-safe path handling.
- Add project documentation skeleton.

### Phase 2 — Container persistence

- Integrate the extension into the Pi image.
- Establish the fixed Pi agent directory.
- Add the persistent volume to the launcher.
- Verify one-time `/login` survives container recreation.
- Verify concurrent containers can use the same authentication volume.
- Verify stable worktree paths produce separate resumable Pi sessions.

### Phase 3 — Host supervisor

Review checkpoints: **3a** private runtime directories, advisory locks and socket server/client; **3b** trusted configuration and constrained read-only Git discovery/path authorization (with an inspect-only CLI); **3c** Docker lifecycle integration and revalidation of those boundaries. The Linux lock backend uses the existing util-linux `flock` utility, not an npm/native dependency. Confirm the deployment host OS before selecting other backends.

- Resolve worktree/common-Git paths.
- Implement per-worktree runtime locking.
- Implement private socket lifecycle.
- Start Docker as an attached child while serving requests.
- Handle signals and cleanup.
- Ensure Kitty and Docker sockets are absent from the container.

### Phase 4 — Worktree creation and opening

- Implement create-or-open host request.
- Create task branches from the current local branch.
- Set local upstream for newly created task branches.
- Add linked worktrees under the configured root.
- Launch a new Kitty tab running the same supervisor.
- Handle existing branches, existing worktrees, and already-open locks.

### Phase 5 — Listing and recovery

- Implement Git worktree discovery and live status derivation.
- Implement `/worktrees` selector.
- Implement host list/open flow for use when all Pi tabs are closed.
- Reopen the latest Pi session using the stable worktree path.
- Test abrupt tab/container shutdown recovery.

### Phase 6 — Kitty state rendering

- Implement extension title updates for Pi lifecycle events.
- Implement trusted Kitty custom tab-bar rendering.
- Document socket-only Kitty remote-control configuration.
- Confirm a container cannot address or recolor another Kitty window.

### Phase 7 — Git completion and integration commands

- Implement Git-only `/worktree-done`.
- Implement merge-based `/worktree-sync` using the local upstream.
- Implement fast-forward-only `/worktree-merge <name>`.
- Handle sync conflicts without touching the target worktree.
- Keep all project test execution outside the extension.

### Phase 8 — Hardening and documentation

- Test malformed protocol messages and command-injection attempts.
- Test branch names containing slashes and unusual valid characters.
- Test nested task branches created from feature branches.
- Test missing, renamed, deleted, and accidentally replaced upstreams.
- Test worktree path and lock collisions.
- Document installation, authentication, everyday usage, recovery, merging, conflict resolution, and security trade-offs.

## 16. Project test strategy

These are tests for the extension/launcher itself, not tests for user projects.

### Unit tests

- Protocol schema validation
- Branch-name validation
- Worktree directory-name derivation
- Git status classification
- Local-upstream resolution
- Runtime lock identity
- Terminal-title state formatting and parsing

### Integration tests using temporary Git repositories

- Create a task from `main`
- Create a task from a feature branch
- Create a nested task from another task branch
- List and reopen linked worktrees
- Preserve dirty changes across container/tab shutdown simulation
- Detect an already-open worktree
- Synchronize a task with its upstream
- Produce and preserve a merge conflict in the task worktree
- Resolve the conflict and fast-forward the target
- Reject a non-fast-forward target update without modifying the target
- Detect merged and upstream-gone branches

### Container smoke tests

- Persistent Pi agent volume survives `--rm` containers
- Separate worktree paths produce separate Pi session discovery
- Supervisor socket is reachable
- Docker and Kitty sockets are not present
- Correct UID/GID ownership is maintained

### Manual Kitty tests

- New tabs launch correctly from `/worktree`
- Titles and colors update for each Pi state
- Closing one tab does not affect another
- A container cannot invoke Kitty remote control
- Reopening a worktree restores the correct Pi session

## 17. Initial user workflow

### One-time setup

1. Build the Pi image with the extension.
2. Create the persistent Pi agent volume.
3. Configure Kitty socket-only remote control on the host.
4. Install or link the trusted custom tab-bar file.
5. Point the existing Pi alias to the host launcher.
6. Start one container and run `/login` once.

### Daily use

1. Run the alias in any existing Git worktree.
2. Work normally in the initial Pi session.
3. Run `/worktree feature1` to create a sibling task from the current branch.
4. Continue working in either Kitty tab.
5. Use `/worktrees` to list or reopen linked worktrees.
6. Commit task changes manually through Pi or Git.
7. Run `/worktree-done` to mark the current clean task tab green.
8. If the target advanced, run `/worktree-sync` in the task tab and resolve any conflicts there.
9. Run `/worktree-merge feature1` from the target branch’s tab to fast-forward it.
10. Run project tests manually whenever and wherever appropriate.
11. Close tabs freely; branches, worktrees, changes, authentication, and Pi sessions persist.
12. Remove merged worktrees manually with Git when no longer needed.

## 18. Acceptance criteria

The initial implementation is complete when:

- A user can start Pi through the revised alias using the existing Docker image workflow.
- Authentication performed once is available in all later task containers.
- `/worktree <name>` creates a branch from the current feature branch, records that feature branch as the local upstream, creates its worktree, and opens a new Kitty tab/container.
- The original Pi session remains open.
- `/worktrees` discovers worktrees from Git without a persistent task registry and can reopen a closed one.
- Closing Kitty never deletes a worktree or its changes.
- The same worktree cannot be opened by two managed containers simultaneously.
- Pi sessions resume correctly for reopened worktrees.
- Tab colors reflect the current Pi state without exposing Kitty remote control to containers.
- Sync conflicts occur in the task worktree, not the target worktree.
- Target integration is fast-forward-only and leaves the target unchanged when synchronization is required.
- No command runs user project tests or provisions project services.
- The container has no Docker socket, Kitty socket, or general-purpose host execution capability.

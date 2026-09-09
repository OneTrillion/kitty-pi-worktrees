# Host launcher

The host supports Linux, Node 24+, `/usr/bin/git` (tested with 2.39.5), util-linux `/usr/bin/flock`, `/usr/bin/docker` with a local Unix endpoint, and `/usr/bin/kitty`. Real deployment checks remain required; see [validation](validation.md).

## Install a trusted release

Build from a reviewed source revision, then install a **separate copy outside the repository and task root**. Do not run host code, Node, dependencies or Kitty scripts from a checkout containers can modify. For example, from this source checkout:

```sh
npm ci --ignore-scripts
npm run check
release="$HOME/.local/lib/pi-worktree/$(git rev-parse --short HEAD)"
mkdir -p "$(dirname "$release")"
mkdir "$release"                    # fail rather than overwrite an existing release
cp -R dist "$release/"
cp package.json package-lock.json "$release/"
(cd "$release" && npm ci --omit=dev --ignore-scripts)
```

Build the [matching image](../container/README.md) from that same revision. Do not update files in a running release or change image tags underneath active supervisors. Close managed sessions first; keep old releases until their processes have exited. Existing Docker aliases may contain extra initialization or mounts: review those explicitly rather than forwarding arbitrary old Docker arguments.

## Explicit trusted configuration

Create a mode-0600 JSON file outside all task mounts, for example `/home/alice/.config/pi-worktree/shop.json`:

```json
{
  "image": "pi-worktree:local",
  "agentVolume": "pi-agent",
  "repositoryPath": "/home/alice/projects/shop",
  "worktreeRoot": "/home/alice/tasks/shop",
  "runtimeRoot": "/run/user/1000/pi-worktree",
  "dockerSocket": "/var/run/docker.sock"
}
```

Requirements:

- `repositoryPath` is the original/main checkout, with an actual `.git` directory. Its branch need not be named `main`.
- `worktreeRoot` is an existing, dedicated, separate directory, not inside or above the original checkout. Authorized linked worktrees are **immediate children**; Git still supplies their paths and branches. Create this empty root explicitly before loading config.
- Repository/task directories and the runtime parent must exist at canonical absolute paths, without symlink aliases. The launcher creates the runtime root if absent. Use a short, local-filesystem runtime path suitable for Unix sockets.
- All supervisors for the same worktrees must use **one runtime root and Docker daemon**. Do not change either while sessions or leftovers can survive. Do not move active worktrees.
- `dockerSocket` defaults to `/var/run/docker.sock`. It must resolve to a local Unix socket outside task mounts, owned by this user or root. TCP/SSH endpoints and inherited Docker contexts are not accepted.
- Optional `kittySocket` is the absolute filesystem socket path (without `unix:`). Otherwise the launcher uses host `KITTY_LISTEN_ON` when it is a filesystem `unix:` address. Kitty may append its PID; use the **actual** address, and update explicit config after a Kitty restart. See [Kitty setup](../kitty/README.md).
- The image must already exist locally (`--pull=never`). The Docker client uses an empty private config and a fresh environment, not `~/.docker` credential helpers or environment-selected executables.
- The config is a user/root-owned regular file, not group/world writable, not a symlink/hard link, and at most 64 KiB. Keep its directory and all installed host resources trusted as well.
- Config, installed code/dependencies, Node/Docker/Kitty executables, runtime and control sockets must remain outside every task mount. Mount paths with commas, quotes, controls, traversal or reserved container-path overlaps are rejected; ordinary spaces and Unicode are supported.

The loader rejects unknown keys. It does not search project files, interpolate variables, execute commands, repair permissions, or create a task registry. Use a separate explicit config for each repository.

The task container does not receive host Git global config. Configure commit identity in the repository if needed, especially for sync merge commits:

```sh
git -C /home/alice/projects/shop config user.name 'Alice'
git -C /home/alice/projects/shop config user.email 'alice@example.com'
```

## Commands

All commands require `--config /absolute/path/to/host.json`:

| Command | Scope |
| --- | --- |
| `inspect` | From the selected worktree/subdirectory: print Git location, branch and HEAD; no Docker, lock or mutation |
| `start` | From the selected worktree: run Pi attached in **this terminal**; TTY and non-root UID/GID required |
| `list [--json]` | Use configured repository regardless of cwd; live Git status via isolated Docker helpers |
| `open <branch-or-ID-prefix>` | Use configured repository; open one existing worktree in a **new** Kitty tab |
| `recover` | From selected worktree: explicitly stop/remove its verified leftover task container |
| `recover-git` | Use configured repository: explicitly stop/remove a verified orphan Git helper |

An alias after installing/testing the release:

```sh
alias piw='node /home/alice/.local/lib/pi-worktree/RELEASE/dist/host/cli.js start --config /home/alice/.config/pi-worktree/shop.json'
```

`list`, `open` and `recover-git` work when all managed tabs are closed and need no TTY. `open` accepts a branch or an unambiguous lowercase hex ID prefix (at least 8 characters), never a path/revision. Already-active worktrees are reported without focusing or changing their tabs. Dirty/conflicted closed worktrees can reopen; unavailable inspections are refused. Human lists sanitize untrusted text; JSON output is ASCII-escaped. `list --json` includes unavailable entries with reasons; inspect each record's `inspection` field, not just the outer success flag.

### Start Pi in the current tab

After [image/volume setup](../container/README.md), invoke the alias from an authorized worktree in Kitty. Startup discovers Git paths, acquires the worktree lifetime lock, creates a private request socket, pins mount identities, and creates a **stopped** named container. It verifies the ID/ownership and revalidates mounts, Git pointers and socket identity before attached start. The image continues the latest session in `/pi/agent/sessions/<canonical-worktree-path-hash>`.

The supervisor serves exactly four [request operations](protocol.md). Each repository operation is serialized under a **separate repository OS mutex**. Creation attaches an existing branch without changing its upstream, or creates a new branch at the source HEAD with the source local branch as parent. A slug plus full branch hash determines the destination. Existing paths fail without overwriting.

Only a new Kitty tab may be launched, with a fixed supervisor command and `--keep-focus --hold`. The repository mutex stays held until the new supervisor's lifetime lock is observed (up to 15 seconds). This confirms handoff, **not successful Pi initialization**; inspect the held tab for errors. An unconfirmed launch or client timeout is not proof nothing happened. Inspect Git and the new tab before retrying. Failed creation preserves any branch, worktree or preallocated empty destination for explicit inspection; there is no destructive rollback.

### Shutdown

- Normal completion returns the attached Docker exit status. SIGINT/SIGTERM/SIGHUP request cleanup (130/143/129).
- The server stops accepting requests and aborts handlers. Cleanup stops the verified task ID with a 10-second grace period, removes it without force/volume deletion, and confirms absence.
- The attachment disconnects only after removal. Request handlers (including Git-helper cleanup) must settle before private directories and lifetime locks are released.
- Worktrees, branches, dirty files and the named Pi volume remain. Container files outside prescribed mounts are disposable. Kitty's held tab may remain after the command exits; close it explicitly.
- If Docker state/stop/removal is uncertain, cleanup **retains the lock and retries**. Restore daemon access (or undo a manual pause). Repeated termination does not bypass this protection.

Managed task/helper containers deliberately do **not** use `--rm`. Ownership labels contain a managed marker, path hashes and run UUID; helpers additionally have `io.pi-worktree.role=git`. Predictable names are duplicate/orphan guards, not a task registry.

## Recovery

SIGKILL, host failure or an interrupted cleanup can leave containers. OS lock release does **not** prove Docker stopped. Startup refuses an occupied task name; it also refuses an active/orphan repository helper. It never automatically steals or kills one.

### Recover a leftover container

After verifying the old tab is gone, run from that worktree with the same runtime/daemon configuration:

```sh
node /trusted/pi-worktree/dist/host/cli.js recover --config /absolute/host.json
```

Recovery must acquire the worktree lock and verify managed/worktree/repository labels and run UUID before stopping/removing the exact full ID. A live session or unrecognized name collision is refused; no leftover is a no-op. Git and named volumes are untouched.

### Recover a leftover Git helper

If list/creation/start reports a helper left over, first wait for any live operation. If its owner died:

```sh
node /trusted/pi-worktree/dist/host/cli.js recover-git --config /absolute/host.json
```

This acquires the **repository mutex nonblocking** and verifies the helper name/scope/role before removing it by full ID. A live owner holding the mutex prevents recovery. It never removes task containers. Interrupted worktree creation may have changed Git before failure: inspect `git worktree list`, branch/upstream and the preserved destination explicitly before retrying; no forced repair or deletion occurs.

If Git metadata or container ownership is unrecognized, investigate on the host. Never delete lock files to unlock a worktree. Empty 0600 lock files are not persisted open/closed state. Private runtime directories left by abrupt death are not swept automatically; clear them only after **all** sessions/helpers have stopped. Do not unlink live lock files or reset a runtime root while Docker writers survive.

## Git execution boundary

Host discovery runs only fixed read-only builtins: worktree metadata, ref/HEAD resolution and branch syntax/existence checks. It uses an absolute Git executable, explicit worktree/Git/common paths, a fresh environment, no global/system config, no pager/hooks/fsmonitor, no object replacement, no lazy fetching and no transport protocols. It never runs host project status, checkout, merge or worktree-add.

Status and creation instead run in temporary **non-root, network-disabled helpers**, with read-only rootfs, dropped capabilities, no-new-privileges and writable `/tmp`. Inspection mounts only the selected worktree/common Git read-only. Creation mounts only the host-precreated empty destination and common Git read/write, **not the source files or destination parent**. Helpers receive no agent volume, credentials or supervisor/Docker/Kitty socket. A deterministic per-repository container name blocks replacement after owner death. Cancellation retains the repository mutex until verified cleanup completes.

The shared Git backend disables hooks, fsmonitor, maintenance/auto-GC, signing, executable clean/smudge/process filters, external merge drivers and remote/lazy fetches. `/worktree-done`, sync and ff-only integration use that backend **inside the task container**; task inspection uses the helper. These commands never intentionally run project checks. Config and files can still change concurrently: this is not isolation of a task from its own agent.

Important restrictions:

- Linked `.git`, `commondir` and backlink files must agree and point to this repository's `worktrees/<id>` metadata. Reads are bounded and reject symlinks, hard links and non-regular files. Git-listed paths alone are not mount authorization.
- Main/linked worktrees, cwd subdirectories/symlink aliases, detached HEAD, SHA-1 and SHA-256 are supported. Bare/separate-Git/nested repositories, unauthorized/unregistered worktrees and unborn/unreadable HEAD are refused. Missing/prunable entries are shown unavailable, not repaired.
- Git-only checks/integration refuse submodules/gitlinks and active cherry-pick/revert/sequencer state. Filter-dependent worktrees (for example expanded LFS files) can look dirty with filters disabled; use manual Git operations for unsupported semantics.
- Common Git is **always a separate bind**, including inside the main checkout, so a container cannot replace that mount root with a symlink. Task-root parents are never mounted. Directory inode/Git pointer revalidation occurs before helper/task start, but is not atomic protection against hostile simultaneous **host** filesystem edits.
- Shared Git metadata means tasks are not isolated from each other. Keep agents idle during sync/integration; cleanliness/head checks are snapshots, not transactional locks on another agent's work.

# Host launcher

The host currently supports **Linux**, Node 24+, `/usr/bin/git` (tested with Git 2.39.5), util-linux `/usr/bin/flock`, and `/usr/bin/docker` connected to a local Unix socket. `inspect`, `start`, and `recover` are implemented. Automatic Kitty tab opening and Pi worktree commands are still pending.

**Deployment checks are pending:** lifecycle tests use a controlled fake Docker CLI/daemon, not real Docker or a Kitty terminal.

## Explicit trusted configuration

Create a JSON file outside every directory that task containers can modify, for example `~/.config/pi-worktree/shop.json`:

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

- `repositoryPath` is the original/main checkout, with an actual `.git` directory. Its checked-out branch need not be named `main`.
- `worktreeRoot` is a dedicated existing directory for task worktrees. It must be separate from the original checkout, not inside or above it. Authorized linked worktrees are immediate children of this root; their paths/branches still come from Git, not a task registry.
- Repository/task directories and the runtime parent must already exist at canonical absolute paths (no symlink aliases). The runtime root itself is created later by the supervisor's runtime helper, not by configuration loading.
- Every supervisor for this user must use the same private runtime root to share advisory locks. Use a local filesystem and a short path suitable for Unix sockets.
- `dockerSocket` is optional, defaulting to `/var/run/docker.sock`. Only an absolute local socket path is accepted, never a TCP/SSH URL. Its canonical target must be outside task mounts and owned by this user or root. Use the same Docker daemon for every session/recovery of a worktree; do not switch endpoints while containers may remain.
- The image must already exist locally: supervised creation uses `--pull=never`. Docker's inherited context/environment and normal `~/.docker` config/credential helpers are not used. Each session gets an empty, private Docker CLI config directory. Rootless/user-namespace UID mapping still requires deployment validation.
- The config file must be owned by the launching user or root and not group/world writable. It must be a regular file, not a symbolic/hard link, and at most 64 KiB. Mode 0600 is recommended.
- The config, installed application (including dependencies), Node/Docker executables, runtime root, and Docker socket must remain outside all task mounts. Install/copy trusted host code separately when working on this project itself; do not symlink it back into the checkout being mounted.

The loader does not search project files, interpolate shell/environment expressions, execute commands, repair permissions, or create a registry. Unknown keys and arbitrary command/Docker/mount options are rejected. This is host policy for one repository, not duplicated task state.

## Inspect without Docker

Build the code, then invoke the diagnostic command from the target worktree or one of its subdirectories:

```sh
npm run build
# From the target worktree:
node /path/to/trusted/pi-worktree/dist/host/cli.js inspect \
  --config /home/alice/.config/pi-worktree/shop.json
```

It prints JSON containing `worktreePath`, `gitDir`, `commonGitDir`, `branch` (null for detached HEAD), and `head`. Non-ASCII characters are escaped in the JSON output so Git-controlled names cannot inject terminal control/bidi text. Errors are JSON on stderr with a nonzero exit code.

This command does not start a container, lock/reserve a worktree, change Git state, or run project checks. `list` and `open` CLI modes are still pending. Inspection is a live snapshot, not an atomic guarantee against simultaneous manual Git edits.

## Start Pi in the current tab

After building the integrated image and preparing the agent volume (see [container setup](../container/README.md)), run from the worktree in a Kitty terminal:

```sh
node /path/to/trusted/pi-worktree/dist/host/cli.js start \
  --config /home/alice/.config/pi-worktree/shop.json
```

A possible host alias, after testing your installation:

```sh
alias piw='node /path/to/trusted/pi-worktree/dist/host/cli.js start --config /home/alice/.config/pi-worktree/shop.json'
```

`start` requires terminal stdin/stdout and a non-root host UID/GID. It discovers the current worktree, acquires its advisory lock, creates a private request socket, revalidates mount directories/socket identity, and creates a **stopped** named container. After verifying its ID/ownership labels and revalidating Git paths again, it runs `docker container start --attach --interactive <id>` with inherited terminal I/O. The image entrypoint continues the latest Pi session.

There is no registry or persistent completion flag. Docker labels record only runtime ownership: managed marker, hashes of the worktree/common Git paths, and a random run UUID. The predictable container name is an additional duplicate-open guard, not a replacement for the OS lock. The private request server runs while Pi is attached, but currently returns `unavailable` for valid worktree operations because their handlers are not implemented yet.

### Shutdown

- Normal completion propagates the attached Docker CLI's exit status. SIGINT/SIGTERM/SIGHUP request cleanup (exit codes 130/143/129 respectively).
- The server stops accepting requests and aborts handlers. Cleanup stops the verified container ID with Docker's 10-second grace period, then removes it without `--force` or `--volumes` and confirms it is gone.
- Only then is the attached Docker client terminated if necessary. Active request handlers must finish before private directories and the worktree lock are released.
- Named Pi volumes and Git worktrees/branches/files are never deleted. Files outside the prescribed mounts were never promised persistence.
- If Docker state/stop/removal cannot be confirmed, the supervisor logs a notice, **keeps the lock and retries**, even if the tab has closed. Restore daemon access (or undo a manual pause) to allow cleanup. Repeated termination signals do not bypass this protection.

Supervised containers deliberately do **not** use Docker auto-remove (`--rm`). Keeping the stopped container until verified cleanup avoids losing identity during races and makes interrupted startup recoverable. The auth-only example in the container docs still uses `--rm`.

## Recover a leftover container

SIGKILL, host/process failure, or a forcibly interrupted cleanup can leave a running or stopped container. OS lock release alone does **not** prove Docker stopped. A new `start` refuses any occupied worktree container name; it never automatically steals, attaches to, or kills that container.

After checking that the previous managed tab is gone, use this explicit **host-only** command from that worktree:

```sh
node /path/to/trusted/pi-worktree/dist/host/cli.js recover \
  --config /home/alice/.config/pi-worktree/shop.json
```

It must acquire the same worktree lock and match the managed/worktree/repository labels and run UUID before stopping/removing that exact ID. A live managed tab or an unrecognized name collision is refused. No leftover is a no-op. Nothing is deleted from Git or the named agent volume. This command is intentionally not part of the container request protocol.

If the image is absent, Docker is inaccessible, Git metadata is corrupt, or an unrecognized container owns the name, fix/inspect the problem explicitly on the host; do not delete lock files. Abrupt death can also leave private runtime directories. Recovery does not sweep other tabs' directories; normal shutdown removes its own, and the host runtime location can be cleared once all sessions are stopped.

## Discovery boundary

Discovery uses `git worktree list --porcelain -z`, then checks the current cwd against the configured repository and task root. A Git-listed path alone is not mount authorization. Linked `.git`, `commondir`, and backlink files must agree and resolve to this repository's own `worktrees/<id>` metadata. Pointer reads are bounded, reject symlinks/hard links and non-regular files, and do not repair anything.

Main/linked worktrees, subdirectories, symlink aliases of cwd, detached HEAD, SHA-1 and SHA-256 repositories are supported. Separate Git directories, bare repositories as the configured main checkout, nested repositories/submodules, unregistered/out-of-policy worktrees and unborn/unreadable HEAD are refused. Existing worktrees in other locations are not deleted or moved; choose a suitable dedicated root or discuss additional host policy first.

The reader runs only fixed discovery builtins, using an absolute Git executable, explicit worktree/Git/common paths, a fresh environment, no automatically loaded system/global config, no pager/hooks/fsmonitor, no object replacement, **no lazy fetching**, and no allowed transport protocols. A missing promisor object must fail rather than launch a configured remote helper. Tests cover that execution path with a harmless marker script.

**This is not a general Git sandbox.** Git still reads repository config and includes. Do not extend this reader with status, checkout, worktree creation, merge or fetch commands: those can invoke additional repository-controlled programs. They require a separate execution-isolation design before host-side use.

The Docker argument builder now always bind-mounts the common Git directory separately, including inside the original checkout. On Linux that mount point cannot be replaced from inside the container, preventing a later common-directory bind from being redirected by replacing `.git` with a symlink. The task-root parent must never be mounted into task containers. Startup checks canonical paths and device/inode identities before create and before attach, and validates its own private socket. These checks detect observed replacements; they are not an atomic sandbox against concurrent hostile host filesystem operations. Real Docker bind behavior, terminal restoration, tab-close behavior, authentication, and file ownership still need deployment smoke tests.

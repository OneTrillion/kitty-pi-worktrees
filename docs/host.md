# Host configuration and inspection

The host currently supports **Linux**, Node 24+, `/usr/bin/git` (tested with Git 2.39.5), and util-linux `/usr/bin/flock` for locking. Docker execution and automatic Kitty tab opening are not wired up yet.

## Explicit trusted configuration

Create a JSON file outside every directory that task containers can modify, for example `~/.config/pi-worktree/shop.json`:

```json
{
  "image": "pi-worktree:local",
  "agentVolume": "pi-agent",
  "repositoryPath": "/home/alice/projects/shop",
  "worktreeRoot": "/home/alice/tasks/shop",
  "runtimeRoot": "/run/user/1000/pi-worktree"
}
```

Requirements:

- `repositoryPath` is the original/main checkout, with an actual `.git` directory. Its checked-out branch need not be named `main`.
- `worktreeRoot` is a dedicated existing directory for task worktrees. It must be separate from the original checkout, not inside or above it. Authorized linked worktrees are immediate children of this root; their paths/branches still come from Git, not a task registry.
- Repository/task directories and the runtime parent must already exist at canonical absolute paths (no symlink aliases). The runtime root itself is created later by the supervisor's runtime helper, not by configuration loading.
- Every supervisor for this user must use the same private runtime root to share advisory locks. Use a local filesystem and a short path suitable for Unix sockets.
- The config file must be owned by the launching user or root and not group/world writable. It must be a regular file, not a symbolic/hard link, and at most 64 KiB. Mode 0600 is recommended.
- The config, installed application (including dependencies), Node executable, and runtime root must remain outside all task mounts. Install/copy trusted host code separately when working on this project itself; do not symlink it back into the checkout being mounted.

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

This command does not start a container, lock/reserve a worktree, change Git state, or run project checks. `start`, `list`, and `open` CLI modes are still pending. Inspection is a live snapshot, not an atomic guarantee against simultaneous manual Git edits.

## Discovery boundary

Discovery uses `git worktree list --porcelain -z`, then checks the current cwd against the configured repository and task root. A Git-listed path alone is not mount authorization. Linked `.git`, `commondir`, and backlink files must agree and resolve to this repository's own `worktrees/<id>` metadata. Pointer reads are bounded, reject symlinks/hard links and non-regular files, and do not repair anything.

Main/linked worktrees, subdirectories, symlink aliases of cwd, detached HEAD, SHA-1 and SHA-256 repositories are supported. Separate Git directories, bare repositories as the configured main checkout, nested repositories/submodules, unregistered/out-of-policy worktrees and unborn/unreadable HEAD are refused. Existing worktrees in other locations are not deleted or moved; choose a suitable dedicated root or discuss additional host policy first.

The reader runs only fixed discovery builtins, using an absolute Git executable, explicit worktree/Git/common paths, a fresh environment, no automatically loaded system/global config, no pager/hooks/fsmonitor, no object replacement, **no lazy fetching**, and no allowed transport protocols. A missing promisor object must fail rather than launch a configured remote helper. Tests cover that execution path with a harmless marker script.

**This is not a general Git sandbox.** Git still reads repository config and includes. Do not extend this reader with status, checkout, worktree creation, merge or fetch commands: those can invoke additional repository-controlled programs. They require a separate execution-isolation design before host-side use.

The Docker argument builder now always bind-mounts the common Git directory separately, including inside the original checkout. On Linux that mount point cannot be replaced from inside the container, preventing a later common-directory bind from being redirected by replacing `.git` with a symlink. The task-root parent must never be mounted into task containers. Docker behavior and startup/revalidation races still need verification during lifecycle integration; the inspect-only command is not a complete container security boundary.

# Pi Worktree

One Pi session, Docker container and Kitty tab per Git worktree. Git tracks the work; there is no permanent daemon or task database.

## Setup

Requires **Linux**, **Node 24+**, Git, util-linux `flock`, local Docker and Kitty. Run from a non-root account with Docker access.

1. [Build the image and create the Pi volume](container/README.md).
2. [Install the host launcher and configure your repository](docs/host.md).
3. [Set up Kitty](kitty/README.md).
4. Start Pi with your launcher alias and run `/login` once. Reuse the same volume for later sessions.

Keep the host installation, config and Kitty scripts **outside all worktree mounts**. Build the host and image from the same revision; close sessions before upgrading.

## Use

Run your launcher alias inside a configured worktree. It resumes that worktree's latest saved Pi session.

| Pi command                 | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `/worktree <branch>`       | Create or reopen a worktree in a new tab, without changing focus |
| `/worktrees`               | List worktrees and choose one to open                            |
| `/worktree-done`           | Check for clean, committed work and mark the tab done            |
| `/worktree-sync`           | Merge the local parent into the current task                     |
| `/worktree-merge <branch>` | From the parent tab, integrate a task fast-forward-only          |

Typical workflow:

1. From the parent branch, run `/worktree my-task`.
2. Work in the new tab, run your checks and commit.
3. If the parent advanced, run `/worktree-sync` in the task tab. Resolve and commit conflicts there.
4. In the parent tab, run `/worktree-merge my-task`.

These commands **do not run project tests or builds**. Keep both agents idle during integration; Git checks are snapshots, not protection against concurrent edits. `/worktree-done` is optional and does not persist.

New tasks start at the source branch's committed HEAD; uncommitted changes are not copied. The source branch becomes the task's local upstream. **Do not replace it with `git push -u`**. Push without changing tracking, for example `git push origin HEAD:refs/heads/my-task`. Existing branches keep their upstream.

Closing a tab removes its container, not its worktree, branch or Pi volume. Only saved session state resumes—not unsent input or terminal scrollback. Remove finished branches/worktrees manually. Use host `list` and `open` when all tabs are closed; use `recover` or `recover-git` for orphan containers. See [host commands and recovery](docs/host.md#commands).

## Boundaries

- Tasks share Git metadata and the Pi volume, including provider credentials and settings. They are **not isolated from each other**. Do not share this volume with trusted host Pi.
- Tasks have network access, but receive no Docker or Kitty control socket. Host-side Git status and creation run in separate credential-free helpers.
- Unsupported Git layouts and ambiguous parent relationships are refused, not repaired. See [Git restrictions](docs/host.md#git-execution-boundary).
- Real Docker, OAuth and interactive Kitty behavior need validation on your host. Use the [deployment checklist](docs/validation.md) before trusting valuable work or credentials.

## Development

```sh
npm ci
npm run format       # format TypeScript, JSON and Markdown
npm run check        # formatting, strict types, tests, build and compiled smoke test
```

Default tests need no Docker or Kitty. Python renderer tests skip if `python3` is unavailable. To test a built image with disposable data:

```sh
PW_DOCKER_SMOKE_IMAGE=pi-worktree:local npm run smoke:docker
```

Source: `src/host/` (trusted launcher), `src/git/` (container Git), `src/extension/` (Pi commands), `src/shared/` (validation and protocol).

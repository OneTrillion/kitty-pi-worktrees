# Pi Worktree

One interactive Pi session, Docker container, host supervisor, and Kitty tab per Git worktree. Git is the persistent source of truth; there is no task registry or permanent daemon.

The five Pi commands, host launcher/recovery commands, isolated Git helpers, and Kitty tab bar are implemented. Automated tests use real temporary Git repositories, sockets and OS locks, plus fake Docker/Kitty executables. **Real image builds, OAuth, Docker mounts and interactive Kitty behavior still require deployment validation**—see the [smoke checklist](docs/validation.md).

## Requirements and installation

Supported host: **Linux**, Node.js **24+**, Git (`/usr/bin/git`, tested with 2.39.5), util-linux `/usr/bin/flock`, local Docker at `/usr/bin/docker`, and Kitty at `/usr/bin/kitty` with socket-only remote control. Run as a non-root user with Docker access. Other operating systems, rootless UID mappings and SELinux setups are not yet validated.

1. [Build the image and create a persistent Pi volume](container/README.md). Extend your existing Node 24+/Pi 0.84.4 image, or use the optional reference base. The extension is built into the image, **not** installed with `pi install`.
2. [Install a trusted host copy and configure the launcher](docs/host.md). Host code, dependencies, configuration and control sockets must be **outside every task mount**, including when developing this project itself.
3. [Install the trusted Kitty tab bar](kitty/README.md) and restart Kitty with socket-only remote control.
4. Point your shell alias at the host `start` command. Start one session, run `/login` once, and reuse that same named Pi volume in later containers.
5. Complete the [deployment checks](docs/validation.md) before using valuable repositories or credentials.

## Everyday use

Run your launcher alias in an authorized Git worktree. It opens Pi in the current terminal and continues that worktree's latest saved session.

| Pi command | Action |
| --- | --- |
| `/worktree <branch>` | Create or reopen a task in a **new** tab; keep the current session and focus |
| `/worktrees` | Select from live Git-derived worktrees; cancel does nothing |
| `/worktree-done` | Require committed, clean, conflict-free work; mark this tab done transiently |
| `/worktree-sync` | Merge the local parent into this task; leave any conflicts here |
| `/worktree-merge <branch>` | From the parent/target tab, integrate a clean task **fast-forward-only** |

These are user commands, not LLM tools or prompts. Git commands require an idle Pi agent. **None runs project tests, lint, CI, builds or services.** Commit your work and run your own checks explicitly.

### Branches, sync and integration

If you run `/worktree payment-tests` from `feature/payments`, the new branch starts at that branch's committed HEAD and records `feature/payments` as its **local upstream/integration target**. Uncommitted source changes are not copied. Tasks can themselves create nested tasks. Existing branches retain their existing upstream; existing linked worktrees are reused. An already-open worktree is reported without focusing or changing its tab.

**Do not use `git push -u` on a managed task**: replacing its local upstream with a remote branch removes the parent relationship. Push explicitly without changing tracking, for example `git push origin HEAD:refs/heads/payment-tests`. Repair a parent explicitly with `git branch --set-upstream-to=feature/payments payment-tests`. Missing, ambiguous or remote parents are never guessed by sync/integration.

Typical integration:

1. Commit task changes, then `/worktree-done` (optional green title, not a test result).
2. If the parent advanced, run `/worktree-sync` in the **task** tab.
3. If it conflicts, resolve files there, stage them and finish the merge with Git. The target tab remains untouched. Sync may create a normal Git merge commit; there are no automatic task commits or conflict resolutions.
4. From the parent tab, run `/worktree-merge payment-tests`. It checks both worktrees and refuses non-fast-forward updates. It does not delete the branch/worktree or run tests.

Checks are live snapshots, **not atomic protection against concurrent manual/agent edits**. Keep both agents idle during integration; the target command cannot freeze another tab's filesystem.

### Close and reopen

Closing a tab stops/removes its managed container, not its branch, worktree, dirty files or named Pi volume. Unsubmitted editor text can be lost; interrupted commands can leave partial changes. Pi 0.84.4 does not flush a brand-new session until its first assistant message. Reopening resumes normal saved session state, not terminal scrollback or unsaved input. `done` is not persisted.

When all tabs are closed, host commands still work with your explicit repository config:

```sh
node /trusted/pi-worktree/dist/host/cli.js list --config /absolute/host.json
node /trusted/pi-worktree/dist/host/cli.js open payment-tests --config /absolute/host.json
```

`open` also accepts an unambiguous ID prefix from `list`. Use `recover` for an orphan task container or `recover-git` for an orphan Git helper, **only on the host**; see [recovery](docs/host.md#recovery). Remove unused worktrees/branches manually with non-forced Git commands after closing their tabs.

## Status and limitations

Lists show branch, path, upstream, abbreviated commit, independent open/closed state, and Git locked/prunable reasons. Status priority is `conflict`, `dirty`, `upstream-gone`, `merged`, `needs-sync`, `ahead`, `clean`. Equal task/parent commits count as `merged`. Unreadable or unauthorized entries are shown as **unavailable**, never assumed clean. A Git worktree lock is distinct from a managed-session runtime lock.

Initial host policy supports a normal main checkout and linked worktrees that are immediate children of a dedicated task root. No bare/separate-Git/nested repositories, unborn HEAD, or automatically moved/repaired worktrees. Detached worktrees can reopen, but creating a new branch from detached HEAD is refused. Git-only checks/integration refuse submodules/gitlinks and active cherry-pick/revert sequences. Executable Git filters and merge drivers are disabled: LFS/attribute-dependent worktrees can appear conservatively dirty or need manual Git operations. See [host boundaries](docs/host.md#git-execution-boundary).

## Security model

Task containers receive only their own worktree, common Git metadata, a shared Pi agent volume, and their private narrow supervisor socket. **No Docker or Kitty control socket/address is forwarded.** Host requests cannot choose paths, commands, images, options or Kitty targets. Status/creation Git runs inside credential-free, network-disabled helper containers, never as general Git commands against host projects.

All task containers can alter shared Git metadata and read/update shared provider credentials, settings and sessions. **Do not share the agent volume with trusted host Pi.** Helpers receive no agent volume or API sockets. Host config and executable selection never come from project settings. Titles are untrusted plain-text UI hints, not security or quality attestations.

Valid creation/open requests have no confirmation, task count limit or rate limit: resource exhaustion is an accepted risk. Tasks have network access for Pi; this is not an outbound-network sandbox. Git sharing is not isolation between tasks, and Docker is not a guarantee against kernel vulnerabilities or hostile host filesystem changes. See the [protocol contract](docs/protocol.md).

## Development

```sh
npm ci
npm run check        # typecheck, all project tests, build
# Optional; requires a built image and real Docker, never uses real credentials:
PW_DOCKER_SMOKE_IMAGE=pi-worktree:local npm run smoke:docker
```

No Docker or Kitty is needed for the default tests. Python renderer tests run when `python3` is available; otherwise they are explicitly skipped. Zod is the only runtime dependency. Compiled modules live in `dist/`.

- `src/host/` — trusted launcher, constrained discovery, locks, Docker/Kitty control
- `src/git/` — shared Git backend and isolated helper worker
- `src/extension/` — Pi commands and title lifecycle
- `src/shared/` — protocol, Git state, title and validation contracts
- `container/`, `kitty/`, `docs/` — deployment files and contributor/user documentation
- `test/` — this software's tests, not automatic checks for user projects
- `.agents/` — AI-only plan and handoff

Release the host installation and image from the same source revision. Stop managed sessions before upgrading; do not overwrite a running installation.

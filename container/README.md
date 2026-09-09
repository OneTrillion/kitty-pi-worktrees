# Container persistence

Phase 2 integration files. **There is no runnable supervisor yet.** Phase 3a adds lock/socket building blocks, not Docker lifecycle integration. This image can be used for authentication checks, but do not use it as a substitute for managed worktree locking.

## Extend your existing Pi image

The base image must be trusted and provide Node **24+**, Pi **0.84.4**, Git, bash, and `/bin/sh`. The build checks versions. It does not install a second Pi or use `pi install`.

From this repository's root, replace `your-existing-pi-image:tag`:

```sh
docker build -f container/Dockerfile \
  --build-arg PI_BASE_IMAGE=your-existing-pi-image:tag \
  --build-arg PI_UID="$(id -u)" --build-arg PI_GID="$(id -g)" \
  -t pi-worktree:local .
docker volume create pi-agent
```

Use a non-root host account. `PI_UID`/`PI_GID` default to 1000. The image replaces the base image's entrypoint, command, default user, HOME and working directory; share any required base-image initialization before relying on this integration.

The compiled extension and its single runtime dependency (Zod) live under `/opt/pi-worktree`, outside the shared volume. The fixed entrypoint explicitly loads the extension and passes `--continue` to Pi. No credentials, agent logs, Git metadata, or `.agents` files enter the build context.

## Login once

This auth-only container has no project or host socket mounts:

```sh
docker run --rm -it --init \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=volume,src=pi-agent,dst=/pi/agent \
  pi-worktree:local
```

Run `/login`, then exit and rerun the same command. Confirm the provider is still authenticated. Use the provider's pasted-code/redirect-URL flow if a browser cannot reach the container's callback. Do not expose host networking or forward host control sockets to work around authentication.

`PI_CODING_AGENT_DIR=/pi/agent` holds auth, settings, model configuration, and sessions. This volume must remain read/write for token refresh. Pi performs auth-file locking; this project adds no auth registry or locking dependency. All task containers can read the credentials and modify this shared directory. Do not share it with unrelated host Pi sessions if you expect the container boundary to protect host execution from modified settings/extensions.

A **new** volume inherits the image directory's UID/GID and private permissions. Rebuilding the image does not change ownership of an existing volume. If the entrypoint reports that it is not writable, check the volume's owner and build/runtime UID/GID; do not make credentials world-writable or automatically recursively chown existing data. Rootless Docker/user namespaces, Docker Desktop socket forwarding, and SELinux require validation on your actual host.

## Launcher contract

`src/host/docker.ts` builds a fixed Docker argument array; it does not run Docker yet.

- One attached `--rm --init` container, as the non-root host UID/GID.
- Worktree and common Git directory at their original absolute paths; the main worktree already contains its common `.git` directory, so it needs no redundant mount.
- One shared named agent volume and one read-only bind of the private supervisor socket. Read-only mounting a Unix socket does not prevent connecting to it.
- No inherited host environment, Docker/Kitty sockets, arbitrary extra options, or host credentials.
- Stable container name and `--session-dir /pi/agent/sessions/<worktree-id>` derived from the canonical path.

Explicit session directories prevent project settings from relocating sessions outside the volume, and prevent collisions in Pi's default slash-to-dash directory encoding. Pi still records the real cwd in each session. Older sessions created by a previous alias/default directory layout are **not automatically migrated**; resume/import them explicitly after integration if needed.

Mount paths with commas, double quotes, controls, traversal, or overlap with reserved container paths are rejected. Ordinary spaces and Unicode are supported. The future supervisor must additionally resolve/authorize real paths, verify socket type/ownership, handle symlinks, hold locks, and stop containers before releasing them. The argument builder alone is not an authorization boundary.

## Validation

`npm run check` covers launch arguments, the real entrypoint with a fake Pi executable, and Pi persistence in fresh local processes using temporary directories and synthetic credentials. Concurrent auth updates and separate/resumable sessions are tested without network/model calls. These are **not** Docker or real OAuth checks.

On the deployment host, still verify:

1. The overlay image builds against your base and `/login` survives `--rm` recreation.
2. Two different managed worktrees share authentication but resume different sessions.
3. Created worktree files have the host UID/GID.
4. The supervisor socket works; Docker/Kitty sockets and their environment variables are absent.
5. Closing a tab/container leaves files and sessions intact.

Items 2–5 need the upcoming supervisor. Submitted messages are subject to Pi's normal persistence behavior; in Pi 0.84.4 a brand-new session is not flushed until its first assistant message. Neither this integration nor tab closing adds an extra save guarantee.

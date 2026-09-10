# Container setup

The base image needs Node **24+**, Pi **0.84.4**, Git, bash and `/bin/sh`. The build verifies the versions and bundles the extension; do not use `pi install`.

## Build

From the repository root, as your non-root host user:

```sh
docker build -f container/Dockerfile \
  --build-arg PI_BASE_IMAGE=your-existing-pi-image:tag \
  --build-arg PI_UID="$(id -u)" --build-arg PI_GID="$(id -g)" \
  -t pi-worktree:local .
docker volume create pi-agent
```

Without an existing Pi image, build the reference base first and use `pi-worktree-base:local` above:

```sh
docker build -f container/Base.Dockerfile -t pi-worktree-base:local .
```

The reference base includes Node, Pi, Git, bash, CA certificates and ripgrep. Add project tools to your own trusted base image. Never bake credentials into an image.

The integration replaces the base image's entrypoint, command, user, HOME and working directory. Preserve any initialization your old image needs. UID/GID default to 1000; use your actual host IDs.

## Login once

This auth-only container mounts no project or host sockets:

```sh
docker run --rm -it --init \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=volume,src=pi-agent,dst=/pi/agent \
  pi-worktree:local
```

Run `/login`, exit, then rerun the command to check persistence. Use the provider's pasted-code/redirect-URL flow if its browser callback cannot reach the container. Do not forward host sockets or enable host networking to work around login.

For worktree sessions, use the [host launcher](../docs/host.md), not this direct Docker command.

## Persistence

- `/pi/agent` stores credentials, settings, model configuration and sessions. Keep the volume writable for token refresh.
- All tasks can read and modify the volume. **Do not share it with trusted host Pi**.
- New volumes inherit the image's UID/GID. Rebuilding does not fix an existing volume's ownership. Check ownership explicitly; do not make credentials world-writable or recursively chown existing data automatically.
- Sessions use `/pi/agent/sessions/<canonical-worktree-path-hash>` to avoid path-name collisions. Old sessions from other directory layouts are not migrated automatically.
- Pi 0.84.4 does not flush a brand-new session until its first assistant message. Closing a tab adds no extra save guarantee.
- Files outside the worktree, common Git directory and Pi volume are disposable.

The compiled extension and Git worker live under `/opt/pi-worktree`, outside the volume. Tasks get only their worktree, common Git metadata, Pi volume and private supervisor socket. Git helpers get no Pi volume, credentials or API sockets. See [host boundaries and recovery](../docs/host.md#git-execution-boundary).

## Check the image

```sh
PW_DOCKER_SMOKE_IMAGE=pi-worktree:local npm run smoke:docker
# For a different local socket, also set PW_DOCKER_SMOKE_SOCKET.
```

Run as the deployment user. The smoke test uses disposable repositories, a UUID-named volume and synthetic markers—not real credentials. It checks mounts, ownership, persistence, the private socket and helper creation, but does not exercise OAuth or the Pi TUI.

Complete the [deployment checklist](../docs/validation.md) for real login, session resume, tab closing and terminal behavior. Rootless Docker, user namespaces and SELinux also need validation on your host.

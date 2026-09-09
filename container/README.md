# Container persistence

Image integration for the host supervisor, Pi extension and isolated Git worker. Use the [host `start` command](../docs/host.md#start-pi-in-the-current-tab) for worktree sessions; the direct Docker example below is for authentication only. Real image/login/terminal checks remain pending; see [validation](../docs/validation.md).

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

The compiled extension, shared Git backend/worker and single runtime dependency (Zod) live under `/opt/pi-worktree`, outside the shared volume. The fixed entrypoint explicitly loads the extension and passes `--continue` to Pi. No credentials, agent logs, Git metadata, or `.agents` files enter the build context.

## Optional reference base

If you do not have an existing Pi image, build the supplied minimal base first:

```sh
docker build -f container/Base.Dockerfile -t pi-worktree-base:local .
docker build -f container/Dockerfile \
  --build-arg PI_BASE_IMAGE=pi-worktree-base:local \
  --build-arg PI_UID="$(id -u)" --build-arg PI_GID="$(id -g)" \
  -t pi-worktree:local .
docker volume create pi-agent
```

This reference supplies Node 24, Pi 0.84.4, Git, bash, CA certificates and ripgrep. It is not assumed to match your old image/alias or project toolchain. Add trusted build-time project tools to your own base if needed; the supervisor has no request-controlled image or service provisioning options. Do not bake provider credentials, Docker/Kitty control addresses or auth files into either image.

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

`src/host/docker.ts` builds fixed arguments; `docker-client.ts` and `supervisor.ts` execute and supervise them.

- One non-root container with `--init`, created stopped with `--pull=never --restart=no`, then started attached by verified ID. Supervised containers do not use `--rm`: the supervisor stops/removes them explicitly after checking identity, without deleting named volumes.
- Worktree and common Git directory at their original absolute paths. The common directory is ALWAYS a separate bind, even inside the main checkout, to prevent the container from replacing that `.git` directory with a symlink.
- One shared named agent volume and one read-only bind of the private supervisor socket. Read-only mounting a Unix socket does not prevent connecting to it.
- No inherited host environment, Docker/Kitty sockets, arbitrary extra options, or host credentials.
- Stable container name and `--session-dir /pi/agent/sessions/<worktree-id>` derived from the canonical path.

Explicit session directories prevent project settings from relocating sessions outside the volume, and prevent collisions in Pi's default slash-to-dash directory encoding. Pi still records the real cwd in each session. Older sessions created by a previous alias/default directory layout are **not automatically migrated**; resume/import them explicitly after integration if needed.

Mount paths with commas, double quotes, controls, traversal, or overlap with reserved container paths are rejected. Ordinary spaces and Unicode are supported. Host configuration/discovery now authorize the normal main-checkout/linked-worktree layout (see [`docs/host.md`](../docs/host.md)). The supervisor revalidates Git paths, mount directory identities and its own socket before create/attach; it holds the lock until container removal and request-handler completion. The argument builder alone is not an authorization boundary.

## Isolated Git helpers

The same fixed image also runs `/opt/pi-worktree/dist/git/worker-cli.js` with Node as an explicit entrypoint, bypassing Pi. The worker only inspects Git or creates a worktree. Helpers use non-root UID/GID, read-only rootfs, no network, dropped capabilities and private writable `/tmp`. Inspection mounts the worktree/common Git read-only. Creation mounts the preallocated destination and common Git read/write; no parent task directory or source worktree files are mounted.

Helpers receive **no agent volume, credentials or host-control sockets**. The host holds a repository mutex until the verified helper has stopped and been removed, including on cancellation. An orphan blocks new helpers/startup until host `recover-git` verifies ownership and removes it. See [host recovery](../docs/host.md#recovery).

## Validation

`npm run check` covers launch arguments, the real entrypoint with a fake Pi executable, and Pi persistence in fresh local processes using temporary directories and synthetic credentials. Lifecycle tests use a fake Docker CLI with persistent test-only daemon state, plus real Unix sockets, OS locks and process signals. They cover normal/failing startup, shutdown, ambiguous API responses, ownership collisions, SIGKILL recovery and preserving worktree files. These are **not** real Docker, TTY or OAuth checks.

An opt-in real-Docker test uses fresh temporary repos, a UUID-named test volume and synthetic markers only (never your `pi-agent` volume):

```sh
PW_DOCKER_SMOKE_IMAGE=pi-worktree:local npm run smoke:docker
# Optional for a different local daemon:
# PW_DOCKER_SMOKE_SOCKET=/run/user/1000/docker.sock
```

Run as the non-root deployment user with an image built for that UID/GID. It checks stable paths, persistence across `--rm` containers, distinct session directory markers, ownership, private socket reachability, absence of control sockets/environment, common `.git` mount-point protection, compiled extension registration and helper creation into a preallocated bind. It does **not** log in, call a model, run the Pi TUI or prove OAuth/session resume in Kitty. The default test suite does not run it. See the complete [deployment checklist](../docs/validation.md).

On the deployment host, still verify:

1. The overlay image builds against your base and `/login` survives `--rm` recreation.
2. Two different managed worktrees share authentication but resume different sessions.
3. Created worktree files have the host UID/GID.
4. The supervisor socket works; Docker/Kitty sockets and their environment variables are absent.
5. Closing a tab/container leaves files and sessions intact.

Use the host `start` command for items 2–5. Also verify SIGTERM/HUP cleanup, terminal restoration, and explicit `recover` after an intentionally interrupted supervisor. Submitted messages are subject to Pi's normal persistence behavior; in Pi 0.84.4 a brand-new session is not flushed until its first assistant message. Neither this integration nor tab closing adds an extra save guarantee.

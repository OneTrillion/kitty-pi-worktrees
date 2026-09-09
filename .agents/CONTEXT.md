# Implementation handoff

## User instructions / review cadence

- Implement `.agents/plans/IMPLEMENTATION_PLAN.md` step by step; pause at review checkpoints.
- User moved this handoff and the plan into `.agents/`. **Do not recreate root CONTEXT.md or IMPLEMENTATION_PLAN.md.** AI-only artifacts go in `.agents/`; README, protocol and installation docs are user/contributor docs and stay outside it.
- Use **Node 24+**. Keep code simple and dependencies few. Avoid adding abstractions/dependencies without a concrete need.
- Current checkpoint: Phase 1 complete; Phase 2 image/launch/persistence code added, deployment checks pending. No supervisor or user commands yet. No commits made by the assistant this turn.

Still awaiting the user's **existing Dockerfile/image workflow, Pi launch alias, and host OS**. Do not silently assume Docker Desktop/rootless/SELinux/socket behavior or discard required base-image initialization.

## Current code

- TypeScript ESM/NodeNext, output `dist/`. Node runs `.ts` tests directly (`node --test`); removed `tsx`/esbuild. Source imports use `.ts`; TS `rewriteRelativeImportExtensions` emits `.js`. `erasableSyntaxOnly` prevents syntax Node cannot strip. No extra test runner/bundler.
- One runtime dependency: Zod for strict schemas/inferred types. Three dev dependencies: TypeScript, Node 24 types, Pi 0.84.4 (types/persistence tests). Keeping Zod is simpler than a new handwritten schema framework. Lockfile regenerated.
- `src/shared/branch.ts`: literal Git branch policy plus shell/control rejection, 1,024-byte max, Unicode without normalization.
- `src/host/branch.ts`: authoritative `git check-ref-format refs/heads/<name>` through execFile. Avoids revision/shorthand expansion.
- `src/host/paths.ts`: safe bounded slug + full branch SHA-256; opaque ID from canonical absolute path SHA-256. Pure derivation, not filesystem authorization.
- `src/shared/protocol.ts` and `framing.ts`: strict v1 request/response validation, bounded stream decoding. Details in `docs/protocol.md`.
- `src/extension/index.ts`: typed **no-op** entry point only.
- `src/host/docker.ts`: pure fixed Docker argv builder, not a running launcher. Takes trusted host image/named volume + canonical/authorized worktree/Git/socket paths + non-root UID/GID. No arbitrary Docker args or inherited environment. Preserves absolute mount paths; main worktree avoids redundant common Git mount. Named container uses worktree ID, shared agent volume at `/pi/agent`, private socket at `/run/pi-worktree/supervisor.sock` (read-only bind still permits connect), caps dropped, no-new-privileges, attached `--rm --init`.
- Mount grammar rejects comma/quote/control/traversal/trailing slash and reserved system/image path overlaps. These lexical checks **do not** authorize mutable Git metadata paths or symlinks.
- `container/Dockerfile`: overlay with REQUIRED `PI_BASE_IMAGE`; no guessed/replacement base image. Build stage Node 24; runtime base must already provide Node 24+, matching Pi 0.84.4, Git/bash/sh. Checks versions. Extension/Zod copied outside volume to root-owned `/opt/pi-worktree`. UID/GID build args (default 1000); `/pi/agent` private and owned accordingly. New volumes inherit ownership; existing volumes do not get recursively chowned. Replaces base ENTRYPOINT/CMD/USER/HOME/WORKDIR, so review with actual base image.
- `container/start.sh`: checks agent volume writable, creates ephemeral HOME, execs Pi with explicit built-in extension and `--continue`.
- `.dockerignore`: allowlist of build inputs excludes credentials, Git data and `.agents`.
- `container/README.md`: overlay/auth setup and manual smoke checklist. README updated for Node 24, moved notes and current partial status.

## Persistence decisions / discovered Pi behavior

1. Set `PI_CODING_AGENT_DIR=/pi/agent` with one shared RW named volume for auth/settings/models/sessions. No custom auth persistence or task registry.
2. Pi 0.84.4 default session folder encoding maps `/repo/a/b` and `/repo/a-b` identically. Launch args now explicitly set `--session-dir /pi/agent/sessions/<worktree-id>` (hash already used for identity); preserve original cwd too. This also overrides project `sessionDir` settings. No path-to-task registry. Old alias/default sessions are NOT automatically migrated.
3. Pi 0.84.4 doesn't flush a brand-new session until its first assistant message; do not promise every submitted first message survives abrupt shutdown. Documented this caveat rather than overriding Pi's persistence.
4. Shared Pi settings/extensions/auth are container-writable. Don't mount this same agent directory into trusted host Pi sessions if isolation from container-modified settings matters.

## Verification

After a clean `npm ci --ignore-scripts`, `npm run check`: **84 tests passed**, typecheck and build passed on Node 24.20.0. `npm audit --omit=dev` found 0 vulnerabilities; shell syntax, compiled shared/extension imports, and `git diff --check` also passed. Tests include:
- 74 original branch/path/protocol/framing cases (still pass with native Node TS).
- Fixed Docker argv, mount constraints, same-worktree identity/session stability and encoding collisions.
- Actual shell entrypoint with a fake Pi executable; no UI/provider calls.
- Fresh Pi processes with TEMPORARY agent dirs and synthetic credentials: four concurrent locked auth updates survive restart; auth file mode 0600.
- Synthetic saved Pi sessions resume independently across fresh processes, including colliding default path encodings.

AuthStorage isn't publicly exported by Pi 0.84.4. The test alone resolves the pinned package's internal `core/auth-storage.js` relative to its public module URL to exercise the real locking backend. Production code does not depend on this internal API. SessionManager is public.

Docker and Kitty executables are **absent** here. Image build, actual `/login`/OAuth refresh, volume ownership/population, live socket bind mounting and tab/container behavior are **not verified**. Current tests are local process checks, not container smoke tests. No user project tests/commands were run.

Commands: `npm ci`, `npm run check`. Git inspection still uses `git -c safe.directory=/workspace ...`; no global safe.directory changes. Unlike the initial session, the user's Phase 1 changes now have a committed baseline (`09bb902` at this turn's start).

## Protocol contract to preserve

- Only create-or-open (literal branch), list, open (ID), inspect (ID). No path/source-branch/command/image/options/Kitty target request fields.
- IDs are not authorization tokens. Rediscover and match against host-authorized worktrees in this repository per request; no persisted ID registry.
- 4-byte BE byte count + UTF-8 JSON, max request 16 KiB / response 1 MiB. One request/response per connection.
- Client half-closes after request; server uses `allowHalfOpen: true`, validates at EOF **before dispatch**, responds and closes. Reject trailing/multiple frames. Implement incomplete-frame deadlines and cleanup in socket layer, not request-count/rate limits. Match success response op to request.
- Oversize list returns response-too-large, never silent truncation. `inspection: unavailable` cannot claim clean. Runtime open and Git locked are distinct. No persisted done state. Treat response strings as untrusted display data.

## Security prerequisites for Phase 3/4 (not solved by Phase 2)

Writable shared Git metadata lets containers alter hooks, config/includes, filters/fsmonitor/external programs, templates, worktree pointers and symlinks. Argument arrays/strict JSON are NOT sufficient:
- Design/test hardened host Git execution before running worktree/status operations against this metadata.
- Enforce host mount/path authorization independently of mutable `.git` pointers and discovered paths. A hash doesn't make a path safe. Verify the socket is the supervisor's own socket, not a substituted control socket.
- Trusted supervisor/config/tab-bar artifacts must not be installed directly in a checkout writable by containers.
- OS-released advisory worktree locks (not PID files or mkdir locks); no live orphan editing container after supervisor lock release. Deterministic Docker name helps reject duplicates but does not replace lifecycle/lock design.
- Handle cross-tab Git/launch races non-destructively. Future inspect-before-merge checks are snapshots and must not claim immunity to arbitrary concurrent edits.

Discuss any required plan adjustment rather than weakening these boundaries silently.

## Docs reviewed / next step

Previously read complete installed `docs/extensions.md` and `examples/extensions/hello.ts`. This turn read complete `containerization.md`, `environment-variables.md`, `sessions.md`, `settings.md`, `session-format.md`, `providers.md`, plus relevant installed auth/session implementation. Installed docs root: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/`.

Pi lifecycle reminders: registerCommand bypasses LLM; use `ctx.ui.setTitle`; idle uses agent_settled, not agent_end; start resources at session_start/command and close idempotently at session_shutdown, never create background resources in the factory.

After this review: obtain base image/alias and host OS, run available Phase 2 container checks and adjust integration. Then Phase 3: trusted config, hardened Git root discovery/path policy, advisory locks, private socket lifecycle, attached Docker execution, signals/orphan cleanup. The existing argv builder is the seam to reuse. Read complete relevant Pi docs/examples and their relevant cross-references before additional Pi API work. Update this handoff and pause for the next code-review checkpoint.

# Implementation handoff

## User request / review cadence

Implement `IMPLEMENTATION_PLAN.md` step by step, allowing code review between steps. Record important decisions here so a new session can resume. **Phase 1 is implemented; pause for user review before Phase 2.** No commits were made.

Questions already asked (awaiting answers):
1. Please share the existing Dockerfile/image workflow and Pi launch alias.
2. What is the host OS? This affects Unix-socket mounting, advisory locking, Docker UID/GID, SELinux, and Kitty setup.

## Repository at start

Only the plan, `day1.jsonl`, `day2.jsonl`, and an empty `.agents/CONTEXT.md` existed. Those files were left unchanged. The user requested `CONTEXT.md`; this root file is the authoritative implementation handoff. The old JSONL logs were not needed/read.

Git reports dubious ownership for `/workspace`. Use `git -c safe.directory=/workspace ...` for inspection. No global Git config changes were made. The plan/logs and newly created project files were untracked at the start/end of this phase; do not assume an existing committed baseline.

## Phase 1 delivered

- Node >=22.19, strict TypeScript ESM/NodeNext, `tsc` build to `dist/`.
- Node built-in test runner via `tsx`; Zod runtime schemas with inferred types.
- Pi API development dependency pinned to installed/documented `@earendil-works/pi-coding-agent` 0.84.4. No runtime import of Pi in host/shared modules. Extension entry point is a typed no-op, not a working command implementation.
- `src/shared/branch.ts`: literal branch syntax + stricter shell/control-character policy, 1,024-byte limit, Unicode accepted without normalization.
- `src/host/branch.ts`: authoritative `git check-ref-format refs/heads/<name>` check with execFile argument array. No `--branch` shorthand expansion.
- `src/host/paths.ts`: bounded readable directory slug plus full branch SHA-256; opaque worktree IDs from canonical absolute path SHA-256. Pure helpers only; filesystem canonicalization, symlink checks, collision enforcement and locks are NOT implemented yet.
- `src/shared/protocol.ts`: strict v1 schemas for create-or-open, list, open, inspect; typed responses, Git-derived status fields, unavailable-inspection variant for missing/prunable entries.
- `src/shared/framing.ts`: bounded streaming decoder and validated encoders.
- `test/`: 74 passing tests for request/response strictness, malicious fields/names, real Git branch checks, path collision resistance, Unicode/size boundaries, chunking, malformed/truncated/oversize frames.
- `README.md`, `docs/protocol.md`, `kitty/README.md`: current status, planned workflow, protocol contract and security boundaries.

## Verification

Run `npm ci` then `npm run check` (typecheck, tests, build).

Last full check passed: **74 tests, 0 failures; typecheck and build passed** on Node v24.20.0/npm 11.19.0. `npm install` and `npm audit --omit=dev` reported 0 vulnerabilities. Importing and calling the compiled no-op extension with Node also passed. Minimum Node version has not been separately tested. First typecheck exposed String.isWellFormed needing ES2024 library declarations; the TS target was updated to ES2024 (the API is available in supported Node versions).

No Docker, authentication, Kitty, socket transport integration, actual worktree mutation, status derivation, or runtime-lock tests have been performed. No user project checks were run. This is not a usable launcher yet.

## Protocol decisions to preserve

- Request fields never accept paths, source branches, commands, Docker options, or Kitty targets.
- Open/inspect select opaque IDs, allowing detached worktrees to be represented without sending paths back. Resolve IDs anew against live, host-authorized Git discovery; no persistent registry. IDs are not security tokens.
- Wire format: 4-byte big-endian byte count, UTF-8 JSON. Request max 16 KiB; response max 1 MiB. One request/response per connection, no multiplexing IDs.
- **EOF before dispatch:** client sends frame then half-closes; server uses `allowHalfOpen: true`, validates at EOF, responds then closes. Decoder rejects trailing data, including later chunks. Future socket layer must enforce incomplete-frame deadlines and cleanup. Client must match successful response `op` to its request.
- No rate limit or task-count cap. Oversize list gets explicit `response-too-large`, not silent truncation; revisit pagination if necessary.
- Existing Git names in responses need not satisfy stricter create-by-name policy. This lets listing expose unusual existing names safely; terminal display sanitization is still needed.
- `inspection: unavailable` cannot claim clean status. Git `locked` differs from runtime `open`. No persistent `done` status.

## Security issues for upcoming phases (important)

The plan intentionally exposes writable common Git metadata to containers. **Argument arrays + branch validation alone do not prevent host execution.** Containers can modify Git config, hooks, filter/fsmonitor commands, includes, templates, and linked-worktree metadata. Before host Git worktree/status operations:
- Design a hardened host Git invocation strategy; test malicious hooks/config/filters/fsmonitor and external command settings.
- Do not trust mutable `.git` pointers, Git-discovered worktree paths, or symlinks as arbitrary host mount authorization. Define and enforce host path policy. Hashing a discovered path does not make it safe.
- Keep supervisor executable/config and Kitty tab-bar source out of container-writable mounts. In particular, installing trusted host artifacts directly from the project checkout that is mounted in a task container undermines the boundary.
- Need OS advisory locks released on process death, not a PID/task registry or stale mkdir lock. Exact implementation depends on host OS.
- Ensure abrupt supervisor death cannot leave a live editing container while releasing its lock (consider lock lifetime and Docker cleanup together).
- Cross-tab requests/races must not launch duplicate managed containers; Git operation races and branch/path collisions must fail non-destructively.
- Phase 7 inspect-before-fast-forward is a snapshot; task edits/commits can race. Define conservative revalidation without claiming protection against arbitrary concurrent manual Git edits.

These are pending design/hardening requirements, not guarantees of the current scaffolding. Discuss a plan adjustment if needed rather than quietly weakening the stated security model.

## Pi documentation reviewed

Installed docs under `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/`:
- Read `docs/extensions.md` completely (3,021 lines).
- Read `examples/extensions/hello.ts` and package.json (version 0.84.4).
- Confirmed: default extension factory; `registerCommand` bypasses LLM; `ctx.ui.setTitle`; idle must use `agent_settled`; background resources start at session_start/command, not factory, and close idempotently at session_shutdown.

Before implementing later Pi features, read their complete relevant docs and linked references: containerization/environment variables/settings/sessions for Phase 2, TUI and title examples for UI, etc. No real Pi API behavior beyond the typed no-op factory has been implemented.

## Next step: Phase 2, after review

1. Obtain current image/alias and host OS instead of guessing deployment assumptions.
2. Read relevant installed Pi persistence/container docs and follow relevant cross-references.
3. Integrate the compiled extension at an immutable image path and load it explicitly; a shared agent volume must not hide the built-in extension.
4. Choose a fixed agent directory/shared volume and trusted Docker launch-config representation, stable absolute worktree paths, and UID/GID ownership strategy. Actual supervisor runtime is Phase 3; Phase 2 can define/test launch arguments and image persistence separately.
5. Perform available smoke checks; clearly mark manual authentication and Kitty checks requiring the user's host.
6. Update this file with exact results, and pause for the next review checkpoint.


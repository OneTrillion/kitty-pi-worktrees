# Supervisor protocol v1

Host and extension must be released from the same source revision. Runtime schemas and inferred types live in `src/shared/protocol.ts`; frame encoding/decoding lives in `src/shared/framing.ts`.

## Transport

- One request and one response per private Unix-stream connection.
- A frame is a 4-byte unsigned big-endian body length followed by exactly that many UTF-8 bytes of JSON.
- Request body: 1–16,384 bytes. Response body: 1–1,048,576 bytes.
- The client sends a frame and half-closes its writable side. The server must use `allowHalfOpen: true`, validate at read EOF, then respond and close its writable side. Client validation likewise finishes at EOF.
- `FrameDecoder` handles arbitrary chunk boundaries. It rejects oversize/zero lengths before allocating a body, trailing bytes, multiple frames, incomplete EOF, malformed UTF-8, BOM, and invalid JSON. Schema parsing rejects unknown keys at every object level, wrong types, unknown operations, and unsupported versions; it does not coerce values.
- `src/host/server.ts` enforces an absolute 5-second incomplete-frame deadline (partial input does not reset it) and a 5-second response-write deadline. It never dispatches before complete validation. Handler execution is separate from these transfer deadlines. These are not request-count or creation-rate limits.
- Oversize lists must return a `response-too-large` error, not a silently truncated list. No fixed task-count limit is imposed by schemas; pagination can be considered in a future version.

## Runtime API and shutdown

`startRequestServer(runtimeRoot, handler)` creates a private socket directory and returns `{ socketPath, close, failure }`. The caller supplies a host-selected 0700 root and trusted handler; no Git/Docker/Kitty operations are built into the transport. Socket paths are limited to 100 UTF-8 bytes. The caller must monitor `failure` (a promise resolving to an Error on an unexpected server failure).

The handler receives `(validatedRequest, abortSignal)`. It must honor cancellation and wait for its child operations to finish before returning. `close()` is idempotent: it stops accepting clients, aborts/destroys connections, waits for active handlers, then removes the per-tab directory. A handler ignoring cancellation can delay shutdown; releasing a worktree lock while it is still running would be unsafe.

`requestSupervisor(socketPath, request, { timeoutMs?, signal? })` validates outbound requests, half-closes after sending, and validates the full response and matching operation at EOF. Its default total deadline is 30 seconds. Cancellation/timeout/disconnection does **not** prove the host operation was cancelled; an outcome may be unknown. There are no automatic retries. The UI should tell users to inspect worktrees before retrying a creation request.

Malformed input gets a bounded error response where possible; timeouts/disconnections may simply close the socket. Handler exceptions and invalid returned objects become generic `internal-error` responses without leaking exception text. Oversize valid output becomes `response-too-large`.

## Requests

```json
{"version":1,"op":"create-or-open","branch":"feature/payments"}
{"version":1,"op":"list"}
{"version":1,"op":"open","worktreeId":"<64 lowercase hex characters>"}
{"version":1,"op":"inspect","worktreeId":"<64 lowercase hex characters>"}
```

No optional request fields. Source worktree/repository and current source branch are resolved by the supervisor, never supplied by the request.

An ID is SHA-256 of a canonical host worktree path. The host must rediscover the current repository's worktrees and match the ID against those entries for every request. IDs are neither secrets nor authorization tokens. Never decode an ID to a path, accept an alternate path field, or maintain a persistent ID/path registry. Detached entries can also be listed/selected by ID.

## Branch and directory policy

`branchNameError()` implements Git ref syntax plus a deliberately stricter request policy: at most 1,024 UTF-8 bytes, well-formed Unicode, no whitespace/control/format characters, no shell metacharacters (`; $ backtick quotes | & < > ( ) { } ! #`), no option-like leading `-`, `HEAD`, or `@`. Slashes, Unicode letters, dots within names, `+`, `=`, `,`, `]`, and embedded `@` are supported when Git permits them. Never trim or normalize names silently.

The host also runs `git check-ref-format refs/heads/<name>` with an argument array before filesystem operations. This validates a literal ref, not a revision or `@{-1}` shorthand. Later Git operations must use fully qualified refs and argument arrays too.

New directory names are `wt-<bounded ASCII slug>-<full SHA-256 of original branch>`. The full hash distinguishes equal slugs, truncated prefixes, casing, and Unicode normalization variants. Derivation is lexical only: callers must canonicalize trusted roots, prevent symlink escape, and fail on an occupied destination. Never overwrite or add numeric collision suffixes. Existing worktree paths come from Git discovery, not re-derivation.

## Responses

Success: `{ "version": 1, "ok": true, "op": <matching operation>, ... }`.

- `create-or-open`: `outcome` is `created`, `reopened`, or `already-active`; includes `worktree`. Creating a linked worktree for an existing branch counts as `created`.
- `open`: `outcome` is `reopened` or `already-active`; includes `worktree`.
- `inspect`: includes `worktree`.
- `list`: includes `worktrees`.

The client must verify the successful response operation matches its request. Errors have no operation because a malformed request may not identify one:

```json
{"version":1,"ok":false,"error":{"code":"git-error","message":"Concise explanation"}}
```

A worktree includes path, nullable branch/HEAD/upstream, independent runtime `open` and Git `locked` flags, and prunable/lock reasons. An `inspection: "ok"` record includes Git status, dirty/conflict flags, and merge/rebase state. An `inspection: "unavailable"` record includes an error instead, never an invented clean status. Upstream records distinguish local versus remote and whether the configured ref resolves. SHA-1 and SHA-256 commit IDs are supported.

`done` is deliberately not a Git worktree status or persisted protocol field.

Response paths, branch names, reasons, and errors are untrusted display data. UI/terminal layers must render them as plain text and remove control sequences. A structurally valid response does not prove Git consistency; status derivation comes in a later phase.

## Host hardening still required

Schema validation protects request fields, not mounted Git metadata. Before serving real operations, address repository-controlled hooks, filters, fsmonitor, external diff/pagers, config includes, templates, symlinks, and forged worktree paths. Host configuration/executable selection must not come from project files. IDs must be matched only to worktrees authorized by host path policy. The [host configuration and discovery reader](host.md) now enforce a limited startup path policy and disable lazy fetching, but are not a general-purpose safe Git runner. The supervisor now integrates OS locks with verified container-ID cleanup and explicit host recovery. It cannot catch SIGKILL; surviving container names block new starts until recovery. Real Docker and terminal behavior still require deployment smoke tests.

The current supervisor serves the protocol but returns `unavailable` for all valid operations until Phase 4/5 handlers are added. `recover` exists only on the host CLI, never as a container request.

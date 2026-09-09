# Kitty integration (Phase 6)

The trusted tab bar and tested configuration will be added in Phase 6.

Required contract:
- Socket-only remote control; the socket and its credentials remain on the host.
- The supervisor may launch new tabs only, never focus or modify an existing tab.
- Pi changes its own title through `ctx.ui.setTitle()`.
- The tab bar parses a fixed state marker and renders the remainder as plain text.
- Idle state follows `agent_settled`, not `agent_end`.

Do not enable unrestricted terminal-escape remote control as a workaround.

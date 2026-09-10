# Kitty integration

The host supervisor uses Kitty remote control **only to launch a new tab**, never to select, focus, recolor, close or execute commands in an existing tab. Pi updates its own terminal title; the trusted tab bar maps a fixed marker to fixed colors.

## One-time host setup

Use a Kitty release supporting `allow_remote_control socket-only` and `launch --keep-focus --hold`. The real Kitty UI has not been exercised in the development container; perform the [manual checks](../docs/validation.md#manual-kitty-and-pi-checks) with your installed version.

1. Copy the reviewed `tab_bar.py` from this release into your **host Kitty config directory** (usually `~/.config/kitty/tab_bar.py`). Back up/merge an existing custom renderer first. Copy it; **do not symlink to code in a task-writable checkout**. Keep the config directory outside all worktree mounts.
2. Add the settings from [`kitty.conf.example`](kitty.conf.example) to your host `kitty.conf`:

   ```conf
   allow_remote_control socket-only
   listen_on unix:${XDG_RUNTIME_DIR}/kitty-pi
   tab_bar_style custom
   tab_bar_min_tabs 1
   ```

3. Ensure `XDG_RUNTIME_DIR` is your private, user-owned runtime directory (normally mode 0700 `/run/user/<uid>`). Restart Kitty; a configuration reload alone may not create a new listen socket.
4. In a **host shell in Kitty**, inspect `printf '%s\n' "$KITTY_LISTEN_ON"`. Kitty can suffix the socket name with its PID; this environment variable contains the actual address. The launcher accepts filesystem `unix:` addresses, not TCP or abstract sockets.
5. Normally no `kittySocket` config field is needed: the supervisor inherits the host shell's address. To run host `open` elsewhere, set `kittySocket` in the trusted host JSON to the actual absolute socket path, without `unix:`. Update it after restarting Kitty if its PID suffix changes.

The config loader does not expand variables in JSON. Keep the socket under the private runtime directory; do not make it world-accessible or enable unrestricted `allow_remote_control yes` to work around errors. The socket address, passwords and `KITTY_*` host environment are not forwarded to task containers. Socket-only control denies requests delivered through the terminal escape channel.

## Titles and behavior

The structured window title is `pi-worktree:<state>:<task>`. It must remain a **window title**: do not force a static tab title, which would hide Pi's updates.

| State       | Color     | Meaning                                                        |
| ----------- | --------- | -------------------------------------------------------------- |
| `starting`  | Gray      | Host launched the new supervisor                               |
| `working`   | Blue      | Pi agent started work                                          |
| `attention` | Amber     | Idle/needs attention, or initial Git state unavailable         |
| `done`      | Green     | User declared clean committed work complete; not a test result |
| `conflict`  | Red       | Git conflicts or merge/rebase state                            |
| `merged`    | Dim green | Task HEAD is contained in its upstream                         |
| `failed`    | Red       | Extension command error                                        |

Idle state is rederived on **`agent_settled`**, not `agent_end` (Pi may retry/compact after the latter). `done` resets on later agent/session activity and is not restored as a persistent flag. Another program in the container can change its own title: colors are UI hints, not trustworthy attestations.

The renderer recognizes only the fixed marker/state whitelist, strips controls/bidi formatting, bounds/clips text by display width and draws remaining text literally—no title templates or evaluation. Unrecognized titles render as plain text using Kitty's normal colors. This script replaces the whole tab bar, including ordinary non-Pi tabs.

New tabs use `--keep-focus`: switch to them manually. `--hold` preserves startup error output and may leave a tab after Pi exits; close it explicitly. Already-active tasks cause **no Kitty command at all**. An accepted launch only confirms supervisor lock handoff, not successful image/TTY/Pi startup; inspect the new tab if the launcher reports uncertainty.

Pure parser/draw-adapter tests run with `python3` in `npm test` when available, or directly with `python3 test/kitty-tab-bar.test.py`. Those mocks do not replace real Kitty rendering, tab-close and socket-only security checks.

#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME"
if [ ! -d "$PI_CODING_AGENT_DIR" ] || [ ! -w "$PI_CODING_AGENT_DIR" ]; then
    echo 'Pi agent volume is not writable. Check its UID/GID ownership (see container/README.md).' >&2
    exit 1
fi
exec pi --extension /opt/pi-worktree/dist/extension/index.js --continue "$@"

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("container entrypoint loads the built-in extension outside the volume and continues Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-wt-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  // Substitute Pi only, so we test the actual shell entrypoint without a TUI/provider.
  await writeFile(join(root, "pi"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
  };
  const { stdout } = await exec(
    "/bin/sh",
    ["container/start.sh", "--session-dir", "/pi/agent/sessions/id with spaces"],
    { env },
  );
  assert.deepEqual(stdout.trimEnd().split("\n"), [
    "--extension",
    "/opt/pi-worktree/dist/extension/index.js",
    "--continue",
    "--session-dir",
    "/pi/agent/sessions/id with spaces",
  ]);
  await assert.rejects(
    exec("/bin/sh", ["container/start.sh"], {
      env: { ...env, PI_CODING_AGENT_DIR: join(root, "missing") },
    }),
    /volume is not writable/,
  );
});

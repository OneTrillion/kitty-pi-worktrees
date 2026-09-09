import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { kittyLaunchArgs, launchInKitty } from "../src/host/kitty.ts";
import { prepareRuntimeRoot } from "../src/host/runtime.ts";
import { setupGit } from "./fixtures/git.ts";

test("Kitty argv can only launch a fixed new-tab supervisor and never targets existing tabs", () => {
  const args = kittyLaunchArgs("/run/user/1000/kitty-123", "/home/user/config.json", "/home/user/tasks/a", "a{unsafe}:done");
  assert.deepEqual(args.slice(0, 7), ["@", "--to", "unix:/run/user/1000/kitty-123", "launch", "--type=tab", "--keep-focus", "--hold"]);
  assert.ok(args.includes("--title") && args.includes("pi-worktree:starting:a{unsafe}:done"));
  assert.ok(!args.some((arg) => /^(--match|--tab-title|--allow-remote-control|--copy-env|set-colors|focus-window)/.test(arg)));
  assert.deepEqual(args.slice(-3), ["start", "--config", "/home/user/config.json"]);
  assert.throws(() => kittyLaunchArgs("tcp:host", "/config", "/repo", "task"));
});

test("host launcher uses only a verified Unix socket and a trusted executable", async (t) => {
  const { base, config, configPath } = await setupGit(t);
  await prepareRuntimeRoot(config.runtimeRoot);
  const socketPath = join(base, "kitty.sock");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const captured = join(base, "kitty-args.json");
  const executable = join(base, "kitty.mjs");
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  await launchInKitty({ ...config, kittySocket: socketPath }, configPath, config.repositoryPath, "main", undefined, executable);
  const args = JSON.parse(await readFile(captured, "utf8")) as string[];
  assert.deepEqual(args, kittyLaunchArgs(socketPath, configPath, config.repositoryPath, "main"));
  await assert.rejects(launchInKitty({ ...config, kittySocket: captured }, configPath, config.repositoryPath, "main", undefined, executable), /trusted host resources/);
  const unsafeExe = join(config.repositoryPath, "kitty");
  await writeFile(unsafeExe, "not executed");
  await assert.rejects(launchInKitty({ ...config, kittySocket: socketPath }, configPath, config.repositoryPath, "main", undefined, unsafeExe), /trusted host resources/);
});

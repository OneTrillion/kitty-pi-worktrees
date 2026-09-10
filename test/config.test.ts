import assert from "node:assert/strict";
import { chmod, link, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadHostConfig } from "../src/host/config.ts";
import { setupGit } from "./fixtures/git.ts";

test("load explicit host configuration without creating a runtime or task registry", async (t) => {
  const { base, configPath, config } = await setupGit(t);
  const before = await readdir(base);
  assert.deepEqual(await loadHostConfig(configPath), config);
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(await readdir(base), before);
});

test("Docker endpoint defaults to a local socket and cannot be a remote URL or task-mounted path", async (t) => {
  const { configPath, config } = await setupGit(t);
  assert.equal(config.dockerSocket, "/var/run/docker.sock");
  for (const dockerSocket of ["tcp://host:2375", "ssh://host", join(config.repositoryPath, "docker.sock")]) {
    await writeFile(configPath, JSON.stringify({ ...config, dockerSocket }));
    await assert.rejects(loadHostConfig(configPath));
  }
});

test("host configuration rejects unknown fields, wrong types, unsafe paths and mount/options syntax", async (t) => {
  const { configPath, config } = await setupGit(t);
  const invalid: unknown[] = [
    null,
    [],
    { ...config, command: "id" },
    { ...config, image: "--privileged" },
    { ...config, image: "image extra" },
    { ...config, agentVolume: "/host/auth" },
    { ...config, agentVolume: "name,readonly" },
    { ...config, repositoryPath: "relative" },
    { ...config, runtimeRoot: "/tmp/a/../run" },
    { ...config, worktreeRoot: "/tmp/a,readonly" },
    { ...config, runtimeRoot: "/tmp/run\n" },
    { ...config, image: 42 },
  ];
  for (const value of invalid) {
    await writeFile(configPath, JSON.stringify(value));
    await assert.rejects(loadHostConfig(configPath));
  }
});

test("host config refuses insecure, symlinked and hard-linked files without rewriting them", async (t) => {
  const { base, configPath } = await setupGit(t);
  const original = await readFile(configPath, "utf8");
  await chmod(configPath, 0o666);
  await assert.rejects(loadHostConfig(configPath), /writable/);
  await chmod(configPath, 0o600);
  const alias = join(base, "alias.json");
  await symlink(configPath, alias);
  await assert.rejects(loadHostConfig(alias));
  const hardLink = join(base, "hard.json");
  await link(configPath, hardLink);
  await assert.rejects(loadHostConfig(hardLink), /hard links/);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("host config bounds file size and rejects malformed JSON/UTF-8", async (t) => {
  const { configPath } = await setupGit(t);
  for (const contents of ["x".repeat(64 * 1024 + 1), "{", Buffer.from([0xff])]) {
    await writeFile(configPath, contents);
    await assert.rejects(loadHostConfig(configPath));
  }
});

test("repository, tasks, runtime, host config and installed code must not overlap", async (t) => {
  const { base, configPath, config } = await setupGit(t);
  const nestedTasks = join(config.repositoryPath, "tasks");
  await mkdir(nestedTasks);
  const installationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const changed of [
    { ...config, worktreeRoot: nestedTasks },
    { ...config, worktreeRoot: base },
    { ...config, runtimeRoot: join(config.repositoryPath, "runtime") },
    { ...config, runtimeRoot: base },
    { ...config, repositoryPath: installationRoot },
  ]) {
    await writeFile(configPath, JSON.stringify(changed));
    await assert.rejects(loadHostConfig(configPath), /outside|separate/);
  }
  const exposed = join(config.repositoryPath, "host.json");
  await writeFile(exposed, JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(loadHostConfig(exposed), /outside/);
});

test("noncanonical directories and separate/symlink Git directories fail closed", async (t) => {
  const { base, configPath, config } = await setupGit(t);
  const alias = join(base, "task-alias");
  await symlink(config.worktreeRoot, alias);
  await writeFile(configPath, JSON.stringify({ ...config, worktreeRoot: alias }));
  await assert.rejects(loadHostConfig(configPath), /canonical/);
  await writeFile(configPath, JSON.stringify(config));
  const common = join(config.repositoryPath, ".git");
  const moved = join(base, "separate-git");
  await rename(common, moved);
  await writeFile(common, `gitdir: ${moved}\n`);
  await assert.rejects(loadHostConfig(configPath), /canonical directory/);
});

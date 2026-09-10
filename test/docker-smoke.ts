// Opt-in, REAL Docker. Uses only disposable repos/volume and synthetic session markers.
// No provider credentials, model requests, Kitty control, or user repositories.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadHostConfig } from "../src/host/config.ts";
import { createDockerClient } from "../src/host/docker-client.ts";
import { dockerRunArgs, sessionDirectory } from "../src/host/docker.ts";
import { locateGit } from "../src/host/git-discovery.ts";
import { runHelper, withRepositoryLock } from "../src/host/git-helper.ts";
import { createRuntimeDirectory, prepareRuntimeRoot } from "../src/host/runtime.ts";
import { startRequestServer } from "../src/host/server.ts";
import { git, setupGit } from "./fixtures/git.ts";

const exec = promisify(execFile);
const image = process.env.PW_DOCKER_SMOKE_IMAGE;
test(
  "real Docker: persistence, stable mounts, UID/GID, socket boundary and isolated helper creation",
  {
    skip: !image && "Set PW_DOCKER_SMOKE_IMAGE to an already-built integrated image",
    timeout: 180000,
  },
  async () => {
    assert.ok(
      process.getuid!() > 0 && process.getgid!() > 0,
      "Run smoke tests as the non-root deployment user",
    );
    const cleanups: Array<() => Promise<void>> = [];
    const f = await setupGit({
      after: (fn) => {
        cleanups.push(fn);
      },
    });
    const volume = `pi-worktree-smoke-${randomUUID()}`;
    await writeFile(
      f.configPath,
      JSON.stringify({
        ...f.config,
        image,
        agentVolume: volume,
        dockerSocket: process.env.PW_DOCKER_SMOKE_SOCKET ?? "/var/run/docker.sock",
      }),
    );
    const config = await loadHostConfig(f.configPath);
    await prepareRuntimeRoot(config.runtimeRoot);
    const control = await createRuntimeDirectory(config.runtimeRoot);
    const client = await createDockerClient(config, control.directory);
    const server = await startRequestServer(config.runtimeRoot, async () => ({
      version: 1,
      ok: true,
      op: "list",
      worktrees: [],
    }));
    const names: string[] = [];
    const prefix = ["--host", `unix://${config.dockerSocket}`, "--config", control.directory];
    const docker = async (args: string[]) =>
      (
        await exec("/usr/bin/docker", [...prefix, ...args], {
          env: { PATH: "/usr/bin:/bin", HOME: control.directory },
          cwd: control.directory,
          timeout: 120000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    let volumeCreated = false;
    try {
      await docker(["volume", "create", volume]);
      volumeCreated = true;
      const destination = join(config.worktreeRoot, "smoke-task");
      await mkdir(destination);
      const source = await locateGit(config, config.repositoryPath);
      const head = await git(config.repositoryPath, ["rev-parse", "HEAD"]);
      // Actual helper worktree add into a PREALLOCATED bind; no parent worktree-root mount.
      await withRepositoryLock(config, () =>
        runHelper(config, client, {
          op: "create",
          branch: "smoke/task",
          destination,
          location: source,
          source: { branch: "main", head },
        }),
      );
      const task = await locateGit(config, destination);
      const state = await withRepositoryLock(config, () =>
        runHelper(config, client, { op: "inspect", location: task }),
      );
      assert.equal(state?.upstream?.ref, "refs/heads/main");
      assert.equal(state?.dirty, false);

      const visits = [
        { location: source, reopen: false },
        { location: task, reopen: false },
        { location: source, reopen: true },
      ];
      for (const { location, reopen } of visits) {
        const name = `pi-worktree-smoke-${randomUUID()}`;
        names.push(name);
        const args = dockerRunArgs(config, {
          ...location,
          socketPath: server.socketPath,
          uid: process.getuid!(),
          gid: process.getgid!(),
        });
        const imageIndex = args.indexOf(config.image);
        const launch = args.slice(0, imageIndex).filter((arg) => arg !== "--interactive" && arg !== "--tty");
        launch[launch.indexOf("--name") + 1] = name;
        // Test probe substitutes node for Pi without modifying the production argv builder.
        const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        (async () => {
          assert.equal(process.cwd(), ${JSON.stringify(location.worktreePath)});
          assert.equal(process.getuid(), ${process.getuid!()});
          assert.equal(process.getgid(), ${process.getgid!()});
          for (const key of ['DOCKER_HOST', 'KITTY_LISTEN_ON', 'KITTY_WINDOW_ID']) assert.equal(process.env[key], undefined);
          for (const path of ['/var/run/docker.sock', '/run/docker.sock', ${JSON.stringify(config.dockerSocket)}, ${JSON.stringify(server.socketPath)}]) assert.equal(fs.existsSync(path), false);
          const { requestSupervisor } = await import('/opt/pi-worktree/dist/shared/client.js');
          assert.equal((await requestSupervisor(process.env.PI_WORKTREE_SOCKET, {version:1,op:'list'})).ok, true);
          // Main parent is writable, proving mount-point protection specifically.
          // A linked task may also be denied by the root-owned unmounted parent.
          assert.throws(() => fs.renameSync(${JSON.stringify(source.commonGitDir)}, ${JSON.stringify(source.commonGitDir + "-moved")}),
            error => ${location.worktreePath === source.worktreePath} ? error.code === 'EBUSY' : ['EBUSY','EACCES','EPERM','EROFS'].includes(error.code));
          const session = ${JSON.stringify(sessionDirectory(location.worktreePath))};
          fs.mkdirSync(session, {recursive:true});
          const marker = session + '/smoke-marker';
          if (${reopen}) assert.equal(fs.readFileSync(marker, 'utf8'), process.cwd());
          else assert.equal(fs.existsSync(marker), false);
          fs.writeFileSync(marker, process.cwd());
          fs.writeFileSync('/pi/agent/smoke-persistence', 'synthetic, not credentials');
          fs.writeFileSync('smoke-owned', 'preserved');
          const owner = fs.statSync('smoke-owned');
          assert.equal(owner.uid, process.getuid()); assert.equal(owner.gid, process.getgid());
          const extension = (await import('/opt/pi-worktree/dist/extension/index.js')).default;
          const commands = []; extension({registerCommand: (name) => commands.push(name), on: () => {}});
          assert.equal(commands.length, 5);
          console.log('smoke-ok');
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
        assert.equal(
          await docker([
            ...launch,
            "--pull=never",
            "--network=none",
            "--entrypoint",
            "node",
            config.image,
            "-e",
            script,
          ]),
          "smoke-ok",
        );
        assert.equal(await readFile(join(location.worktreePath, "smoke-owned"), "utf8"), "preserved");
      }
      const persistenceName = `pi-worktree-smoke-${randomUUID()}`;
      names.push(persistenceName);
      assert.equal(
        await docker([
          "run",
          "--rm",
          "--name",
          persistenceName,
          "--pull=never",
          "--network=none",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "--mount",
          `type=volume,src=${volume},dst=/pi/agent`,
          "--entrypoint",
          "node",
          config.image,
          "-e",
          "console.log(require('fs').readFileSync('/pi/agent/smoke-persistence','utf8'))",
        ]),
        "synthetic, not credentials",
      );
    } finally {
      // Only UUID names allocated by THIS test; never prune/sweep real containers or volumes.
      try {
        for (const name of names) {
          const ids = await docker(["container", "ls", "--all", "--quiet", "--filter", `name=^/${name}$`]);
          if (ids) await docker(["container", "rm", "--force", name]);
        }
        if (volumeCreated) await docker(["volume", "rm", volume]);
      } finally {
        await server.close();
        await control.remove();
        for (const cleanup of cleanups) await cleanup();
      }
    }
  },
);

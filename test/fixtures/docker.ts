import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDockerClient } from "../../src/host/docker-client.ts";
import { runHostSession } from "../../src/host/supervisor.ts";
import { hasErrorCode, parseJson } from "../../src/shared/validation.ts";
import { DockerCallSchema, FakeContainerSchema, type FakeContainer } from "./docker-state.ts";
import { setupGit } from "./git.ts";

export const eventually = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for fixture state");
};

export const setupDocker = async (t: TestContext) => {
  const cleanups: Array<() => Promise<void>> = [];
  const fixture = await setupGit({
    after(fn) {
      cleanups.push(fn);
    },
  });
  const engine = join(fixture.base, "engine");
  await mkdir(engine);
  const statePath = join(engine, "state.json");
  await writeFile(statePath, "[]");
  const socketPath = join(engine, "docker.sock");
  const socketServer = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(socketPath, resolve);
  });
  const executable = join(engine, "docker.mjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.env.PW_FAKE_ENGINE = ${JSON.stringify(engine)};\nawait import(${JSON.stringify(new URL("./fake-docker-cli.ts", import.meta.url).href)});\n`,
    { mode: 0o755 },
  );
  const config = { ...fixture.config, dockerSocket: socketPath };
  await writeFile(fixture.configPath, JSON.stringify(config));
  const factory: typeof createDockerClient = (cfg, dir) => createDockerClient(cfg, dir, executable);
  const notices: string[] = [];
  const sessions: Array<{ abort: AbortController; result: Promise<number> }> = [];
  let currentControls: Record<string, unknown> = {};
  const controls = async (changes: Record<string, unknown>) => {
    currentControls = { ...currentControls, ...changes };
    const path = join(engine, "controls.json");
    await writeFile(path + ".tmp", JSON.stringify(currentControls));
    await rename(path + ".tmp", path);
  };
  const state = async (): Promise<FakeContainer[]> =>
    FakeContainerSchema.array().parse(parseJson(await readFile(statePath, "utf8")));
  const save = async (value: FakeContainer[]): Promise<void> => {
    await writeFile(statePath + ".test", JSON.stringify(value));
    await rename(statePath + ".test", statePath);
  };
  const run = (mode: "start" | "recover" = "start", cwd = config.repositoryPath) => {
    const abort = new AbortController();
    const result = runHostSession(config, cwd, mode, {
      dockerFactory: factory,
      containerUser: { uid: 1000, gid: 1000 },
      signal: abort.signal,
      cleanupRetryMs: 10,
      onNotice: (message) => notices.push(message),
    });
    void result.catch(() => {}); // Tests can inspect rejection later without unhandled promises.
    const session = { abort, result };
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    await controls({ failLookup: false, failStop: false, failRemove: false, badInspect: false });
    for (const session of sessions) session.abort.abort();
    await Promise.allSettled(sessions.map((session) => session.result));
    for (const item of await state()) {
      if (item.attachedPid) {
        try {
          process.kill(item.attachedPid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    for (const cleanup of cleanups) await cleanup();
  });
  return {
    ...fixture,
    config,
    engine,
    executable,
    factory,
    notices,
    state,
    save,
    controls,
    run,
    async calls(): Promise<Array<{ argv: string[]; env: Record<string, string>; pid: number }>> {
      try {
        return (await readFile(join(engine, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => DockerCallSchema.parse(parseJson(line)));
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return [];
        throw error;
      }
    },
  };
};

import { fork } from "node:child_process";

import { randomUUID } from "node:crypto";

import { join } from "node:path";

import { type TestContext } from "node:test";

import { fileURLToPath } from "node:url";

import {
  containerName,
  MANAGED_LABEL,
  REPOSITORY_LABEL,
  RUN_LABEL,
  WORKTREE_LABEL,
} from "../../src/host/docker.ts";

import { worktreeId } from "../../src/host/paths.ts";

import { eventually, setupDocker } from "./docker.ts";

import type { FakeContainer } from "./docker-state.ts";

export type Fixture = Awaited<ReturnType<typeof setupDocker>>;

export const socketPath = (container: FakeContainer): string => {
  const mount = container.createArgs.find((arg) =>
    arg.endsWith("dst=/run/pi-worktree/supervisor.sock,readonly"),
  )!;
  return mount.split(",")[1]!.slice("src=".length);
};

export const running = async (fixture: Fixture): Promise<FakeContainer> => {
  return (await eventually(fixture.state, (items) => items.some((item) => item.State.Running)))[0]!;
};

export const ownedLeftover = (fixture: Fixture, recognized = true): FakeContainer => {
  const config = fixture.config;
  return {
    Id: "b".repeat(64),
    Name: `/${containerName(config.repositoryPath)}`,
    Config: {
      Labels: recognized
        ? {
            [MANAGED_LABEL]: "1",
            [WORKTREE_LABEL]: worktreeId(config.repositoryPath),
            [REPOSITORY_LABEL]: worktreeId(join(config.repositoryPath, ".git")),
            [RUN_LABEL]: randomUUID(),
          }
        : {},
    },
    State: { Running: true, Restarting: false, Paused: false },
    createArgs: [],
  };
};

export const operations = async (fixture: Fixture): Promise<string[][]> => {
  return (await fixture.calls()).map((call) => call.argv.slice(4));
};

export const childSession = (t: TestContext, fixture: Fixture, mode = "start") => {
  const child = fork(
    fileURLToPath(new URL("./supervisor-process.ts", import.meta.url)),
    [fixture.configPath, fixture.executable, mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return { child, exited, stderr: () => stderr };
};

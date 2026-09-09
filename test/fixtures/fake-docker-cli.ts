// TEST ONLY: a tiny persistent fake daemon behind a fake Docker CLI. No Docker is run.
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ContainerInfo } from "../../src/host/docker-client.ts";
import { helperMain } from "../../src/git/worker.ts";

export interface FakeContainer extends ContainerInfo {
  createArgs: string[];
  attachedPid?: number;
  exitCode?: number;
}
const root = process.env.PW_FAKE_ENGINE!;
const statePath = join(root, "state.json");
function state(): FakeContainer[] { return JSON.parse(readFileSync(statePath, "utf8")) as FakeContainer[]; }
function save(value: FakeContainer[]): void {
  const temp = `${statePath}.${process.pid}`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, statePath);
}
const controls = existsSync(join(root, "controls.json"))
  ? JSON.parse(readFileSync(join(root, "controls.json"), "utf8")) as Record<string, unknown> : {};
const argv = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ argv, env: process.env, pid: process.pid }) + "\n");
const args = argv.slice(4); // --host value --config value
function fail(message: string): never { console.error(message); process.exit(125); }
function value(flag: string): string { return args[args.indexOf(flag) + 1]!; }
function fresh(labels: Record<string, string>): FakeContainer {
  return { Id: randomBytes(32).toString("hex"), Name: `/${value("--name")}`,
    Config: { Labels: labels }, State: { Running: false, Restarting: false, Paused: false }, createArgs: args };
}

if (args[0] === "create") {
  if (controls.failCreate) fail("create failed before allocation");
  const containers = state();
  if (containers.some((item) => item.Name === `/${value("--name")}`)) fail("name conflict");
  if (controls.conflictOnCreate) { containers.push(fresh({})); save(containers); fail("raced with another container"); }
  const labels = Object.fromEntries(args.flatMap((arg, index) => {
    if (arg !== "--label") return [];
    const label = args[index + 1]!;
    const separator = label.indexOf("=");
    return [[label.slice(0, separator), label.slice(separator + 1)]];
  }));
  const created = fresh(labels);
  containers.push(created);
  save(containers);
  if (controls.mutateAfterCreate) {
    const { path, text } = controls.mutateAfterCreate as { path: string; text: string };
    writeFileSync(path, text);
  }
  if (controls.swapAfterCreate) {
    const { path, replacement, saved } = controls.swapAfterCreate as { path: string; replacement: string; saved: string };
    renameSync(path, saved);
    renameSync(replacement, path);
  }
  if (controls.replaceSocketAfterCreate) {
    const mount = args.find((arg) => arg.endsWith("dst=/run/pi-worktree/supervisor.sock,readonly"))!;
    const path = mount.split(",")[1]!.slice("src=".length);
    unlinkSync(path);
    writeFileSync(path, "not a supervisor socket");
  }
  if (typeof controls.createDelayMs === "number") await delay(controls.createDelayMs);
  console.log(controls.loseCreateReply ? "not-a-container-id" : created.Id);
} else if (args[0] === "container" && args[1] === "ls") {
  if (controls.failLookup) fail("daemon unavailable");
  const filter = value("--filter");
  const matches = state().filter((item) => filter.startsWith("id=") ? item.Id === filter.slice(3)
    : item.Name === filter.slice("name=^".length, -1));
  for (const item of matches) console.log(item.Id);
} else if (args[0] === "container" && args[1] === "inspect") {
  if (controls.failLookup) fail("daemon unavailable");
  const found = state().find((item) => item.Id === args.at(-1));
  if (!found) fail("not found");
  console.log(controls.badInspect ? "{}" : JSON.stringify(found));
} else if (args[0] === "container" && args[1] === "start") {
  if (controls.failAttach) fail("attach failed");
  const containers = state();
  const found = containers.find((item) => item.Id === args.at(-1));
  if (!found) fail("not found");
  found.State.Running = true;
  found.attachedPid = process.pid;
  save(containers);
  if (found.Config.Labels?.["io.pi-worktree.role"] === "git") {
    if (typeof controls.helperDelayMs === "number") await delay(controls.helperDelayMs);
    const reply = controls.badHelperReply ? "not JSON" : await helperMain(found.createArgs.at(-1)!);
    const current = state();
    const item = current.find((entry) => entry.Id === found.Id);
    if (item) { item.State.Running = false; save(current); }
    console.log(reply);
  } else if (typeof controls.exitCode === "number") {
    const code = controls.exitCode;
    setTimeout(() => {
      const current = state();
      const item = current.find((entry) => entry.Id === found.Id);
      if (item) { item.State.Running = false; item.exitCode = code; save(current); }
      process.exit(code);
    }, 30);
  } else {
    setInterval(() => {
      const current = state().find((item) => item.Id === found.Id);
      if (!current?.State.Running) process.exit(current?.exitCode ?? 0);
    }, 10);
  }
} else if (args[0] === "container" && args[1] === "stop") {
  if (controls.failStop) fail("cannot confirm stop");
  const containers = state();
  const found = containers.find((item) => item.Id === args.at(-1));
  if (!found) fail("not found");
  found.State = { Running: false, Paused: false, Restarting: false };
  save(containers);
  console.log(found.Id);
} else if (args[0] === "container" && args[1] === "rm") {
  if (controls.failRemove) fail("cannot confirm removal");
  const containers = state();
  const found = containers.find((item) => item.Id === args.at(-1));
  if (!found || found.State.Running) fail("not found or still running");
  save(containers.filter((item) => item.Id !== found.Id));
  console.log(found.Id);
} else fail("unexpected Docker operation");

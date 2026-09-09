#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadHostConfig } from "./config.ts";
import { discoverCurrentWorktree } from "./git-discovery.ts";
import { runHostSession } from "./supervisor.ts";

const usage = `Usage: node dist/host/cli.js <inspect|start|recover> --config /absolute/path/to/host.json

inspect  Print current Git worktree metadata; does not start Docker.
start    Run one attached Pi container in this terminal (TTY required).
recover  Stop/remove a verified leftover container while holding the worktree lock.

No command deletes worktrees/branches or runs project checks.`;

// Emit ASCII JSON so Git-controlled names cannot inject terminal controls/bidi text.
function json(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { config: { type: "string" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["inspect", "start", "recover"].includes(command ?? "") || !values.config) {
    throw new Error(usage);
  }
  const config = await loadHostConfig(values.config);
  if (command === "inspect") {
    console.log(json(await discoverCurrentWorktree(config, process.cwd())));
    return;
  }
  if (command === "start" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("start requires an interactive terminal; run it in a Kitty tab");
  }
  try {
    process.exitCode = await runHostSession(config, process.cwd(), command as "start" | "recover");
  } finally {
    // Docker normally restores the terminal itself, but its CLI may have died abruptly.
    if (command === "start" && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* The tab may already be closed. */ }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(json({ error: error instanceof Error ? error.message : "Host command failed" }));
  process.exitCode = 1;
});

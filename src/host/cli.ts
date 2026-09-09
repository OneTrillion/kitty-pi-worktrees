#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadHostConfig } from "./config.ts";
import { discoverCurrentWorktree } from "./git-discovery.ts";

const usage = `Usage: node dist/host/cli.js inspect --config /absolute/path/to/host.json

Inspect the current worktree using explicit trusted host configuration.
This diagnostic command does not start Docker, create worktrees or run project checks.`;

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
  if (positionals.length !== 1 || positionals[0] !== "inspect" || !values.config) {
    throw new Error(usage);
  }
  const config = await loadHostConfig(values.config);
  console.log(json(await discoverCurrentWorktree(config, process.cwd())));
}

void main().catch((error: unknown) => {
  console.error(json({ error: error instanceof Error ? error.message : "Host inspection failed" }));
  process.exitCode = 1;
});

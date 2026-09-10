#!/usr/bin/env node
import { parseArgs } from "node:util";
import { plainText } from "../shared/title.ts";
import { runHostCommand } from "./commands.ts";
import { loadHostConfig } from "./config.ts";
import { discoverCurrentWorktree } from "./git-discovery.ts";
import { runHostSession } from "./supervisor.ts";

const usage = `Usage: node dist/host/cli.js <command> --config /absolute/path/to/host.json

inspect      Print current Git metadata; does not start Docker.
start        Run one attached Pi container in this terminal (TTY required).
list         List live worktree status (add --json for machine-readable output).
open NAME    Open a branch or unambiguous worktree ID from list in a NEW Kitty tab.
recover      Stop/remove a verified leftover task container under its worktree lock.
recover-git  Stop/remove a verified orphan Git helper under the repository lock.

No command deletes worktrees/branches or runs project checks.`;

// Emit ASCII JSON so Git-controlled names cannot inject terminal controls/bidi text.
const json = (value: unknown): string => {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    options: { config: { type: "string" }, help: { type: "boolean" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== (command === "open" ? 2 : 1) ||
    !["inspect", "start", "recover", "list", "open", "recover-git"].includes(command ?? "") ||
    !values.config ||
    (values.json && command !== "list")
  ) {
    throw new Error(usage);
  }
  const config = await loadHostConfig(values.config);
  if (command === "inspect") {
    console.log(json(await discoverCurrentWorktree(config, process.cwd())));
    return;
  }
  if (command === "list" || command === "open" || command === "recover-git") {
    const response = await runHostCommand(config, values.config, command, positionals[1]);
    if (!response) {
      console.log("Git helper recovery complete");
      return;
    }
    if (!response.ok) throw new Error(response.error.message);
    if (response.op === "list" && !values.json) {
      for (const item of response.worktrees)
        console.log(
          [
            item.id.slice(0, 12),
            plainText(item.branch ?? "(detached)"),
            item.head?.slice(0, 10) ?? "?",
            item.open ? "open" : "closed",
            item.inspection === "ok" ? item.status : `unavailable: ${plainText(item.error)}`,
            plainText(item.upstream?.ref ?? "(no upstream)"),
            plainText(item.path, 8192),
            item.locked ? `git-locked: ${plainText(item.lockReason ?? "")}` : "",
            item.prunable ? `prunable: ${plainText(item.pruneReason ?? "")}` : "",
          ]
            .filter(Boolean)
            .join(" | "),
        );
    } else console.log(json(response));
    return;
  }
  if (command === "start" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("start requires an interactive terminal; run it in a Kitty tab");
  }
  if (command !== "start" && command !== "recover") throw new Error(usage);
  try {
    process.exitCode = await runHostSession(config, process.cwd(), command, { configPath: values.config });
  } finally {
    // Docker normally restores the terminal itself, but its CLI may have died abruptly.
    if (command === "start" && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* The tab may already be closed. */
      }
    }
  }
};

void main().catch((error: unknown) => {
  console.error(json({ error: error instanceof Error ? error.message : "Host command failed" }));
  process.exitCode = 1;
});

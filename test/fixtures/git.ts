// TEST ONLY: normal Git operations to construct repositories, never a production runner.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadHostConfig } from "../../src/host/config.ts";

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("/usr/bin/git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], {
    cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function setupGit(t: { after(fn: () => Promise<void>): void }, format: "sha1" | "sha256" = "sha1") {
  const base = await mkdtemp(join(tmpdir(), "pw-git-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repositoryPath = join(base, "repo");
  const worktreeRoot = join(base, "tasks");
  await mkdir(repositoryPath);
  await mkdir(worktreeRoot);
  await git(repositoryPath, ["init", "-b", "main", `--object-format=${format}`]);
  await writeFile(join(repositoryPath, "file.txt"), "initial\n");
  await git(repositoryPath, ["add", "file.txt"]);
  await git(repositoryPath, ["commit", "-m", "initial"]);
  const configPath = join(base, "host.json");
  const input = { image: "pi-worktree:test", agentVolume: "pi-agent", repositoryPath, worktreeRoot, runtimeRoot: join(base, "run") };
  await writeFile(configPath, JSON.stringify(input), { mode: 0o600 });
  const config = await loadHostConfig(configPath);
  return { base, configPath, config };
}

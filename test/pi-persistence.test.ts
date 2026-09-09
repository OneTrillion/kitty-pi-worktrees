import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AGENT_DIR, sessionDirectory } from "../src/host/docker.ts";

const exec = promisify(execFile);

// Fresh Pi processes, isolated temporary agent storage, synthetic credentials only.
// These are SDK persistence checks, NOT Docker or real OAuth/login smoke tests.
async function runPi(agentDir: string, code: string, args: string[] = []): Promise<unknown> {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
    import { SessionManager } from '@earendil-works/pi-coding-agent';
    // Test-only access to the pinned Pi version's internal file-locking backend.
    const { AuthStorage } = await import(new URL('./core/auth-storage.js',
      import.meta.resolve('@earendil-works/pi-coding-agent')).href);
    ${code}
  `, ...args], { env, timeout: 30000, maxBuffer: 16384 });
  return JSON.parse(stdout) as unknown;
}

test("Pi auth survives process recreation and concurrent locked updates", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-wt-auth-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await runPi(agentDir, `
    await AuthStorage.create().modify('test', async () => ({ type: 'api_key', key: '0' }));
    console.log('null');
  `);
  await Promise.all(Array.from({ length: 4 }, () => runPi(agentDir, `
    await AuthStorage.create().modify('test', async current => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { type: 'api_key', key: String(Number(current.key) + 1) };
    });
    console.log('null');
  `)));
  assert.deepEqual(await runPi(agentDir, `console.log(JSON.stringify(await AuthStorage.create().read('test')));`),
    { type: "api_key", key: "4" });
  assert.equal((await stat(join(agentDir, "auth.json"))).mode & 0o777, 0o600);
});

test("Pi resumes separate sessions for stable worktree paths, including default-encoding collisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-wt-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const worktrees = [join(root, "a/b"), join(root, "a-b")];
  const sessions: unknown[] = [];
  for (const cwd of worktrees) {
    // Mirror the fixed container agent directory under temporary storage for this test.
    const sessionDir = join(agentDir, relative(AGENT_DIR, sessionDirectory(cwd)));
    const created = await runPi(agentDir, `
      const sm = SessionManager.create(process.argv[1], process.argv[2]);
      sm.appendMessage({ role: 'user', content: 'Persistence fixture', timestamp: 1 });
      sm.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: 'Synthetic reply, no API call' }],
        api: 'openai-responses', provider: 'openai', model: 'fixture', timestamp: 2,
        stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      });
      console.log(JSON.stringify(sm.getSessionId()));
    `, [cwd, sessionDir]);
    sessions.push(created);
    assert.equal(await runPi(agentDir, `
      const sm = SessionManager.continueRecent(process.argv[1], process.argv[2]);
      console.log(JSON.stringify(sm.getSessionId()));
    `, [cwd, sessionDir]), created);
  }
  assert.notEqual(sessions[0], sessions[1]);
  // Check again after BOTH sessions exist, not only immediately after each creation.
  for (const [index, cwd] of worktrees.entries()) {
    assert.equal(await runPi(agentDir, `
      console.log(JSON.stringify(SessionManager.continueRecent(process.argv[1], process.argv[2]).getSessionId()));
    `, [cwd, join(agentDir, relative(AGENT_DIR, sessionDirectory(cwd)))]), sessions[index]);
  }
});

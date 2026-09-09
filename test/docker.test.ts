import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_DIR, SUPERVISOR_SOCKET, dockerRunArgs, sessionDirectory, type DockerWorktree } from "../src/host/docker.ts";

const config = { image: "pi-worktree:test", agentVolume: "pi-agent" };
const worktree: DockerWorktree = {
  worktreePath: "/home/me/tasks/feature one",
  commonGitDir: "/home/me/project/.git",
  socketPath: "/run/user/1000/pi-wt-123/socket",
  uid: 1000,
  gid: 1000,
};
function values(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}

test("attached container gets only the four prescribed mounts and the host UID/GID", () => {
  const args = dockerRunArgs(config, worktree);
  assert.deepEqual(args.slice(0, 5), ["run", "--rm", "--interactive", "--tty", "--init"]);
  assert.deepEqual(values(args, "--user"), ["1000:1000"]);
  assert.deepEqual(values(args, "--workdir"), [worktree.worktreePath]);
  assert.deepEqual(values(args, "--mount"), [
    `type=bind,src=${worktree.worktreePath},dst=${worktree.worktreePath}`,
    `type=bind,src=${worktree.commonGitDir},dst=${worktree.commonGitDir}`,
    `type=volume,src=pi-agent,dst=${AGENT_DIR}`,
    `type=bind,src=${worktree.socketPath},dst=${SUPERVISOR_SOCKET},readonly`,
  ]);
  assert.deepEqual(values(args, "--env"), [
    `PI_CODING_AGENT_DIR=${AGENT_DIR}`, `PI_WORKTREE_SOCKET=${SUPERVISOR_SOCKET}`,
    "HOME=/tmp/pi-home", "TERM=xterm-256color",
  ]);
  assert.deepEqual(args.slice(-3), [config.image, "--session-dir", sessionDirectory(worktree.worktreePath)]);
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
});

test("main worktree gets a separate common Git bind so the directory cannot be replaced from the container", () => {
  const commonGitDir = `${worktree.worktreePath}/.git`;
  const args = dockerRunArgs(config, { ...worktree, commonGitDir });
  assert.equal(values(args, "--mount").length, 4);
  assert.ok(values(args, "--mount").includes(`type=bind,src=${commonGitDir},dst=${commonGitDir}`));
});

test("reopening keeps identity, cwd, volume and session directory; other worktrees are distinct", () => {
  const first = dockerRunArgs(config, worktree);
  assert.deepEqual(dockerRunArgs(config, worktree), first);
  const other = dockerRunArgs(config, { ...worktree, worktreePath: "/home/me/tasks/other" });
  assert.notDeepEqual(values(first, "--name"), values(other, "--name"));
  assert.notDeepEqual(values(first, "--session-dir"), values(other, "--session-dir"));
  assert.notEqual(sessionDirectory("/repo/a/b"), sessionDirectory("/repo/a-b"));
});

test("no inherited host control-socket, credentials or general Docker options", () => {
  const args = dockerRunArgs(config, worktree);
  assert.doesNotMatch(args.join("\n"), /KITTY|DOCKER_HOST|docker\.sock|API_KEY|--privileged|--network|--pid|--env-file/);
});

test("reject mount grammar injection and noncanonical paths", () => {
  for (const field of ["worktreePath", "commonGitDir", "socketPath"] as const) {
    for (const value of ["relative", "/repo/", "/repo/../other", "/repo//other", "/repo,readonly", '/repo"x', "/repo\nx", "/repo\0x"]) {
      assert.throws(() => dockerRunArgs(config, { ...worktree, [field]: value }), `${field}: ${value}`);
    }
  }
});

test("reject mounts that would hide image files or system paths", () => {
  for (const value of ["/", "/opt/pi-worktree", "/pi/agent", "/pi", "/tmp", "/usr/local", "/run", "/var", "/proc", "/etc"]) {
    for (const field of ["worktreePath", "commonGitDir"] as const) {
      assert.throws(() => dockerRunArgs(config, { ...worktree, [field]: value }));
    }
  }
  assert.throws(() => dockerRunArgs(config, { ...worktree, commonGitDir: "/home/me" }));
  assert.throws(() => dockerRunArgs(config, { ...worktree, socketPath: `${worktree.worktreePath}/socket` }));
  assert.throws(() => dockerRunArgs(config, { ...worktree, socketPath: `${worktree.commonGitDir}/socket` }));
});

test("reject invalid trusted settings rather than interpret them as Docker syntax", () => {
  for (const image of ["", "--privileged", "image --privileged", "image\0x"]) {
    assert.throws(() => dockerRunArgs({ ...config, image }, worktree));
  }
  for (const agentVolume of ["", "/host/auth", "../auth", "auth,readonly", "auth:/host", "auth\nx"]) {
    assert.throws(() => dockerRunArgs({ ...config, agentVolume }, worktree));
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, 0xffffffff]) {
    assert.throws(() => dockerRunArgs(config, { ...worktree, uid: value }));
    assert.throws(() => dockerRunArgs(config, { ...worktree, gid: value }));
  }
});

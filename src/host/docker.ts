import { posix as path } from "node:path";
import { containsPath } from "./files.ts";
import { worktreeId } from "./paths.ts";

export const AGENT_DIR = "/pi/agent";
export const SUPERVISOR_SOCKET = "/run/pi-worktree/supervisor.sock";
export const MANAGED_LABEL = "io.pi-worktree.managed";
export const WORKTREE_LABEL = "io.pi-worktree.worktree";
export const REPOSITORY_LABEL = "io.pi-worktree.repository";
export const RUN_LABEL = "io.pi-worktree.run";
export const RUN_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export const containerName = (canonicalPath: string): string => {
  return `pi-worktree-${worktreeId(canonicalPath)}`;
};

/** Trusted host configuration only; never deserialize this from a socket request. */
export interface DockerConfig {
  image: string;
  agentVolume: string;
}

/** Paths must already be canonicalized and authorized by the supervisor. */
export interface DockerWorktree {
  worktreePath: string;
  commonGitDir: string;
  gitDir?: string;
  socketPath: string;
  uid: number;
  gid: number;
}

const validatePath = (value: string): void => {
  // --mount has its own CSV grammar even without a shell. Reject rather than escape.
  if (
    !path.isAbsolute(value) ||
    value.endsWith("/") ||
    path.normalize(value) !== value ||
    /[,"\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new Error("Mount paths must be normalized absolute POSIX paths without commas, quotes or controls");
  }
};

export const validateDirectoryMount = (value: string): void => {
  validatePath(value);
  const reserved = [
    "/opt",
    "/pi",
    "/run",
    "/var/run",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/usr",
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/tmp/pi-home",
  ];
  if (value === "/" || reserved.some((dir) => containsPath(value, dir) || containsPath(dir, value))) {
    throw new Error("Worktree/Git mount overlaps a reserved container path");
  }
};

export const sessionDirectory = (canonicalWorktreePath: string): string => {
  return `${AGENT_DIR}/sessions/${worktreeId(canonicalWorktreePath)}`;
};

/** Pure argv builder. No Docker execution, environment forwarding or project configuration. */
const taskArgs = (config: DockerConfig, worktree: DockerWorktree): string[] => {
  if (!config.image || config.image.startsWith("-") || /[\s\p{Cc}\p{Cf}]/u.test(config.image)) {
    throw new Error("A fixed image name is required");
  }
  // A volume name, never a host bind path or a mount expression.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(config.agentVolume)) {
    throw new Error("A named Pi agent volume is required");
  }
  for (const id of [worktree.uid, worktree.gid]) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xfffffffe) {
      throw new Error("Task containers require non-root numeric UID/GID");
    }
  }
  validateDirectoryMount(worktree.worktreePath);
  validateDirectoryMount(worktree.commonGitDir);
  validatePath(worktree.socketPath);
  const gitDir = worktree.gitDir ?? worktree.commonGitDir;
  validatePath(gitDir);
  if (!containsPath(worktree.commonGitDir, gitDir))
    throw new Error("Git metadata must be inside the common Git directory");
  if (containsPath(worktree.commonGitDir, worktree.worktreePath)) {
    throw new Error("A worktree cannot be inside its common Git directory");
  }
  if (
    containsPath(worktree.worktreePath, worktree.socketPath) ||
    containsPath(worktree.commonGitDir, worktree.socketPath)
  ) {
    throw new Error("The private socket must be outside container-writable directories");
  }

  return [
    "--interactive",
    "--tty",
    "--init",
    "--name",
    containerName(worktree.worktreePath),
    "--user",
    `${worktree.uid}:${worktree.gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--workdir",
    worktree.worktreePath,
    "--env",
    `PI_CODING_AGENT_DIR=${AGENT_DIR}`,
    "--env",
    `PI_WORKTREE_SOCKET=${SUPERVISOR_SOCKET}`,
    "--env",
    `PI_WORKTREE_ROOT=${worktree.worktreePath}`,
    "--env",
    `PI_WORKTREE_GIT_DIR=${gitDir}`,
    "--env",
    `PI_WORKTREE_COMMON_GIT_DIR=${worktree.commonGitDir}`,
    "--env",
    "HOME=/tmp/pi-home",
    "--env",
    "TERM=xterm-256color",
    "--mount",
    `type=bind,src=${worktree.worktreePath},dst=${worktree.worktreePath}`,
    // A separate mount prevents the container from replacing common Git with a symlink.
    // This is required even when .git is inside the main worktree.
    "--mount",
    `type=bind,src=${worktree.commonGitDir},dst=${worktree.commonGitDir}`,
    "--mount",
    `type=volume,src=${config.agentVolume},dst=${AGENT_DIR}`,
    "--mount",
    `type=bind,src=${worktree.socketPath},dst=${SUPERVISOR_SOCKET},readonly`,
    config.image,
    "--session-dir",
    sessionDirectory(worktree.worktreePath),
  ];
};

export const dockerRunArgs = (config: DockerConfig, worktree: DockerWorktree): string[] => [
  "run",
  "--rm",
  ...taskArgs(config, worktree),
];

/** Create stopped first. The supervisor removes it only after verified shutdown. */
export const dockerCreateArgs = (config: DockerConfig, worktree: DockerWorktree, runId: string): string[] => {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid host-generated run ID");
  return [
    "create",
    "--pull=never",
    "--restart=no",
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${WORKTREE_LABEL}=${worktreeId(worktree.worktreePath)}`,
    "--label",
    `${REPOSITORY_LABEL}=${worktreeId(worktree.commonGitDir)}`,
    "--label",
    `${RUN_LABEL}=${runId}`,
    ...taskArgs(config, worktree),
  ];
};

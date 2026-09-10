// Runs the real lifecycle in a child process, replacing only the Docker executable.
import { loadHostConfig } from "../../src/host/config.ts";
import { createDockerClient } from "../../src/host/docker-client.ts";
import { runHostSession } from "../../src/host/supervisor.ts";

try {
  const config = await loadHostConfig(process.argv[2]!);
  const executable = process.argv[3]!;
  const mode = process.argv[4];
  if (mode !== "start" && mode !== "recover") throw new Error("Invalid supervisor mode");
  process.exitCode = await runHostSession(config, config.repositoryPath, mode, {
    dockerFactory: (cfg, directory) => createDockerClient(cfg, directory, executable),
    containerUser: { uid: 1000, gid: 1000 },
    cleanupRetryMs: 20,
    onNotice: (message) => {
      process.send?.(message);
    },
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
if (process.connected) process.disconnect();

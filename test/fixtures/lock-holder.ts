import { acquireWorktreeLock } from "../../src/host/lock.ts";

const lock = await acquireWorktreeLock(process.argv[2]!, process.argv[3]!);
// Keep the lock handle reachable and the process alive until the parent kills it.
process.on("message", async () => {
  await lock.release();
  process.exit(0);
});
process.send?.("ready");

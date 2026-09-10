import { z } from "zod";
import { ContainerSchema } from "../../src/host/docker-client.ts";

export const FakeContainerSchema = ContainerSchema.extend({
  createArgs: z.array(z.string()),
  attachedPid: z.number().optional(),
  exitCode: z.number().optional(),
});
export type FakeContainer = z.infer<typeof FakeContainerSchema>;

export const DockerCallSchema = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  pid: z.number(),
});

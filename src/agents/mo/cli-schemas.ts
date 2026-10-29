import { z } from "zod";

export const MoStatusSchema = z.object({
  status: z.enum([
    "needs_you",
    "running",
    "waiting_on_agents",
    "failed_start",
    "failed",
    "cancelled",
    "ready",
    "blocked",
    "findings",
    "incomplete",
    "checking",
    "replied",
    "sleeping",
  ]),
  completed: z.boolean().optional(),
  latestTurn: z
    .object({
      messageId: z.string(),
      completedAt: z.string().nullable(),
    })
    .nullish(),
  findings: z.record(z.string(), z.array(z.unknown())).optional(),
  counts: z
    .object({
      bugs: z.number().int().nonnegative().optional(),
      verdicts: z.number().int().nonnegative().optional(),
    })
    .optional(),
  progress: z
    .object({
      agents: z.object({ running: z.number().int().nonnegative() }),
    })
    .optional(),
});
export type MoStatus = z.infer<typeof MoStatusSchema>;

export const MoReadSchema = z.object({
  pendingInput: z.object({ id: z.string() }).nullish(),
});

export function isMoSessionComplete(status: MoStatus): boolean {
  if (!status.latestTurn?.completedAt || status.progress?.agents.running) {
    return false;
  }
  if (status.status === "ready") return status.completed !== false;
  return (
    status.completed === true &&
    status.progress?.agents.running === 0 &&
    ["findings", "incomplete", "blocked", "replied"].includes(status.status)
  );
}

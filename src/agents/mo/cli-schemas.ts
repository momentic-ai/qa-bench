import { z } from "zod";

export const MIN_MO_SESSION_TIME_BUDGET_MINUTES = 10;

export const MoStatusSchema = z.object({
  status: z.enum([
    "running",
    "waiting_on_agents",
    "checking",
    "needs_you",
    "blocked",
    "ready",
    "sleeping",
    "cancelled",
    "failed",
  ]),
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
});
export type MoStatus = z.infer<typeof MoStatusSchema>;

export const MoReadSchema = z.object({
  pendingInput: z.object({ id: z.string() }).nullish(),
});

export function isMoSessionReportReady(status: MoStatus): boolean {
  return ["ready", "blocked", "sleeping", "cancelled"].includes(status.status);
}

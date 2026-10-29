import { z } from "zod";

export const MoStatusSchema = z.object({
  status: z.string(),
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
  return [
    "ready",
    "findings",
    "incomplete",
    "blocked",
    "replied",
    "sleeping",
    "cancelled",
  ].includes(status.status);
}

import { z } from "zod";

export const MIN_MO_SESSION_TIME_BUDGET_MINUTES = 10;

export const MoStatusSchema = z.object({
  state: z.string().nullable(),
  sessionState: z.string().optional(),
  displayState: z.string().optional(),
  attentionPending: z.boolean().optional(),
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
  if (status.attentionPending) return false;
  const lifecycle = status.sessionState ?? status.state;
  const display = status.displayState ?? status.state;
  const legacyDisplayOnly =
    status.sessionState === undefined && status.state === display;
  if (
    !legacyDisplayOnly &&
    lifecycle !== "idle" &&
    lifecycle !== "waitingOnAgents" &&
    lifecycle !== "stopped"
  )
    return false;
  return [
    "ready",
    "findings",
    "incomplete",
    "blocked",
    "replied",
    "sleeping",
    "cancelled",
  ].includes(display ?? "");
}

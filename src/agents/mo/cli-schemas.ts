import { z } from "zod";

/** `qa status` JSON; `status` is the state the web UI shows. */
export const MoStatusSchema = z.object({
  status: z.string().optional(),
  latestTurn: z
    .object({
      messageId: z.string(),
      completedAt: z.string().nullable(),
    })
    .nullish(),
  counts: z
    .object({
      bugs: z.number().int().nonnegative().optional(),
      verdicts: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const MoReadSchema = z.object({
  pendingQuestions: z.array(z.object({ id: z.string() })).optional(),
});

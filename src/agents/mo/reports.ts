import { z } from "zod";

import { FindingSchema } from "../../evals/reports";

export const MoFindingsSchema = z.array(
  FindingSchema.extend({ kind: z.enum(["bug", "flag"]) }),
);
export const MoReportSchema = z
  .object({ findings: z.object({ bugs: z.string() }).passthrough() })
  .passthrough();
export const MoCostSchema = z
  .object({
    totals: z.array(
      z.object({ currency: z.string(), amount: z.number() }).passthrough(),
    ),
  })
  .passthrough();

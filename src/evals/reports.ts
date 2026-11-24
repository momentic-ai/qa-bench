import { z } from "zod";

export const FindingSchema = z
  .object({
    name: z.string(),
    summary: z.string(),
    expected: z.string(),
    actual: z.string(),
    reproSteps: z.array(z.string()),
  })
  .passthrough();
export type Finding = z.infer<typeof FindingSchema>;

export const ReportSchema = z
  .object({
    bugs: z.array(FindingSchema.strict()),
    areasExplored: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

/** A Codex or Claude bug's video clip, cut from its browser recording. */
export const BugRecordingSchema = z
  .object({
    /** The clip is artifacts/<artifactId>.mp4 in the report directory. */
    artifactId: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .strict();
export type BugRecording = z.infer<typeof BugRecordingSchema>;

/** A Codex or Claude report, whose bugs may carry a video clip. */
export const CodingAgentReportSchema = ReportSchema.extend({
  bugs: z.array(
    FindingSchema.extend({ recording: BugRecordingSchema.optional() }).strict(),
  ),
});

/** Unlike ReportSchema, strips extra keys the agent adds instead of rejecting the whole report. */
export const LenientReportSchema = z.object({
  bugs: z.array(
    z.object({
      name: z.string(),
      summary: z.string(),
      expected: z.string(),
      actual: z.string(),
      reproSteps: z.array(z.string()),
    }),
  ),
  areasExplored: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});

export const DurationSchema = z
  .object({
    duration: z.number(),
    timeLimitMs: z.number().int().positive().optional(),
    partial: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
    valid: z.boolean().optional(),
  })
  .passthrough();

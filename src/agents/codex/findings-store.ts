import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJson } from "../../evals/json-file";
import { FindingSchema, ReportSchema } from "../../evals/reports";

const SubmittedBugSchema = z
  .object({ id: z.string().min(1), bug: FindingSchema.strict() })
  .strict();
const RemoveBugSchema = z.object({ id: z.string().min(1) }).strict();
const CoverageSchema = z
  .object({
    areasExplored: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();
const SavedFindingsSchema = CoverageSchema.extend({
  bugs: z.array(SubmittedBugSchema.extend({ submittedAt: z.iso.datetime() })),
});

export const FINDINGS_TOOLS = [
  {
    type: "function",
    name: "submit_bug",
    description:
      "Persist a completed, verified bug immediately. Use a stable id for this underlying defect; repeat the id to replace its evidence. Only accept bugs you reproduced, never guesses. The accepted findings are the eval result even if execution is interrupted.",
    inputSchema: z.toJSONSchema(SubmittedBugSchema),
  },
  {
    type: "function",
    name: "remove_bug",
    description:
      "Remove a previously accepted bug by id when disproved or identified as a duplicate.",
    inputSchema: z.toJSONSchema(RemoveBugSchema),
  },
  {
    type: "function",
    name: "record_coverage",
    description:
      "Incrementally persist areas explored and limitations. Entries are added to the saved report without replacing earlier coverage.",
    inputSchema: z.toJSONSchema(CoverageSchema),
  },
];

export class FindingsStore {
  private bugs = new Map<
    string,
    { bug: z.infer<typeof FindingSchema>; submittedAt: string }
  >();
  private areasExplored = new Set<string>();
  private limitations = new Set<string>();
  private pending = Promise.resolve();
  private sealed = false;
  private file: string;

  constructor(reportDirectory: string) {
    this.file = path.join(reportDirectory, "accepted-findings.json");
  }

  async initialize() {
    await this.persist();
  }

  handleTool(tool: string, args: unknown) {
    if (this.sealed) {
      // Deadline shutdown closes admission while already accepted writes drain.
      throw new Error("The evaluation has stopped accepting findings.");
    }
    let apply: () => void;
    if (tool === "submit_bug") {
      // Stable IDs make retries and corrections replace an existing finding.
      const { id, bug } = SubmittedBugSchema.parse(args);
      apply = () => {
        // Corrections keep the first submission time as the discovery time.
        const submittedAt =
          this.bugs.get(id)?.submittedAt ?? new Date().toISOString();
        this.bugs.set(id, { bug, submittedAt });
      };
    } else if (tool === "remove_bug") {
      // Retractions remove disproved or duplicate findings before scoring.
      const { id } = RemoveBugSchema.parse(args);
      apply = () => {
        this.bugs.delete(id);
      };
    } else if (tool === "record_coverage") {
      // Coverage is cumulative across journeys and survives early termination.
      const coverage = CoverageSchema.parse(args);
      apply = () => {
        coverage.areasExplored.forEach((area) => this.areasExplored.add(area));
        coverage.limitations.forEach((limitation) =>
          this.limitations.add(limitation),
        );
      };
    } else {
      // Unknown tools must fail explicitly instead of looking like saved data.
      throw new Error(`Unknown reporting tool: ${tool}`);
    }
    const update = this.pending.then(async () => {
      const previousBugs = new Map(this.bugs);
      const previousAreas = new Set(this.areasExplored);
      const previousLimitations = new Set(this.limitations);
      apply();
      try {
        await this.persist();
      } catch (err) {
        this.bugs = previousBugs;
        this.areasExplored = previousAreas;
        this.limitations = previousLimitations;
        throw err;
      }
    });
    // Keep the queue usable after a failed write; the caller still receives and logs its rejection.
    this.pending = update.catch(() => {});
    // Tool success is acknowledged only after its atomic file replacement.
    return update;
  }

  seal() {
    this.sealed = true;
  }

  async collect() {
    await this.pending;
    const saved = SavedFindingsSchema.parse(
      JSON.parse(await readFile(this.file, "utf8")),
    );
    return ReportSchema.parse({
      bugs: saved.bugs.map(({ bug }) => bug),
      areasExplored: saved.areasExplored,
      limitations: saved.limitations,
    });
  }

  private persist() {
    return writeJson(this.file, {
      bugs: [...this.bugs].map(([id, saved]) => ({ id, ...saved })),
      areasExplored: [...this.areasExplored],
      limitations: [...this.limitations],
    });
  }
}

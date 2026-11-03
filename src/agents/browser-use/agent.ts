import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  AgentContext,
  EvalAgent,
  EvalAgentDefinition,
} from "../../evals/agent";
import { hostedAgentRules } from "../../evals/hosted-agent-rules";
import { writeJson } from "../../evals/json-file";
import { ReportSchema } from "../../evals/reports";
import { BrowserUseApiError, BrowserUseClient } from "./client";

const REPORT_FILE = "qa-report.json";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const SessionSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().nullable().optional(),
  latestRunId: z.string().min(1),
  status: z.string(),
});
const RunSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    output: z.unknown().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
const CostSchema = z
  .object({
    llmCostUsd: z.string(),
    searchCostUsd: z.string(),
    browserCostUsd: z.string(),
    proxyCostUsd: z.string(),
    totalCostUsd: z.string(),
  })
  .passthrough();
/** Unlike ReportSchema, strips extra keys the agent adds instead of rejecting the whole report. */
const LenientReportSchema = z.object({
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

export class BrowserUseAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private session: z.infer<typeof SessionSchema> | undefined;
  private workspaceId: string | undefined;
  /** Runs replaced by an interrupting follow-up; their terminal states do not end the session. */
  private readonly interruptedRunIds = new Set<string>();
  private stopping = false;
  private termination: Promise<void> | undefined;
  private launch: Promise<void> | undefined;

  constructor(
    private readonly context: AgentContext,
    private readonly client = BrowserUseClient.fromEnvironment(),
  ) {}

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    if (!this.context.targetUrl)
      throw new Error("Browser Use requires a fixture URL.");
    const workspace = z.object({ id: z.string().min(1) }).parse(
      await this.client.request("workspaces", {
        method: "POST",
        body: { name: `momentic-qa-${randomUUID()}` },
        signal,
      }),
    );
    this.workspaceId = workspace.id;
    const task = `${message}

${hostedAgentRules({
  retrievalTools: "web search",
  initialize: `write ${REPORT_FILE} in your workspace as JSON with empty bugs, areasExplored and limitations arrays. Each bug has name, summary, expected, actual and reproSteps (an array of strings).`,
  update: `Rewrite ${REPORT_FILE}`,
  finalize: "give the same JSON as your final answer",
  closing: `${REPORT_FILE} is collected if the run is stopped at the deadline.`,
})}`;
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-launch.json"),
      { workspaceId: workspace.id, task },
    );
    onReady?.();
    signal.throwIfAborted();
    // Do not cancel a launch in flight: its ID is needed to stop paid work.
    this.launch = this.createRun(task, workspace.id);
    await this.launch;
    signal.throwIfAborted();
    return { completion: this.observe(signal) };
  }

  private async createRun(task: string, workspaceId: string) {
    // No model or modelParams: Browser Use applies its product default.
    const run = z
      .object({ id: z.string().min(1), sessionId: z.string().min(1) })
      .parse(
        await this.client.request("runs", {
          method: "POST",
          body: {
            task,
            workspaceId,
            outputSchema: z.toJSONSchema(ReportSchema),
            // Fixtures are public E2B hosts; a residential proxy only adds cost and latency.
            browserSettings: { proxyCountryCode: null, allowResizing: true },
          },
        }),
      );
    this.session = {
      sessionId: run.sessionId,
      workspaceId,
      latestRunId: run.id,
      status: "queued",
    };
    await this.saveSession();
  }

  async send(message: string, signal: AbortSignal) {
    if (!this.session || this.stopping)
      throw new Error("Browser Use session is not active.");
    await this.refresh(signal);
    this.interruptedRunIds.add(this.session.latestRunId);
    // Queued messages wait for the active run; interrupt so the agent finalizes before the cutoff.
    await this.client.request(
      `sessions/${encodeURIComponent(this.session.sessionId)}/queue`,
      {
        method: "POST",
        body: {
          text: `${message} Rewrite ${REPORT_FILE} now, then finish with the same JSON as your final answer.`,
          interrupt: true,
        },
        signal,
      },
    );
  }

  private async observe(signal: AbortSignal) {
    while (!this.stopping) {
      signal.throwIfAborted();
      await this.refresh(signal);
      const session = this.session;
      if (!session) throw new Error("Browser Use session is not active.");
      if (
        TERMINAL.has(session.status) &&
        !this.interruptedRunIds.has(session.latestRunId)
      ) {
        if (session.status === "completed") return;
        throw new Error(`Browser Use run ${session.status}.`);
      }
      await delay(10_000, undefined, { signal });
    }
  }

  private async refresh(signal?: AbortSignal) {
    if (!this.session) return;
    this.session = SessionSchema.parse(
      await this.client.request(
        `sessions/${encodeURIComponent(this.session.sessionId)}`,
        { signal },
      ),
    );
    await this.saveSession();
  }

  private async saveSession() {
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-session.json"),
      this.session,
    );
  }

  async terminate() {
    const termination = this.termination ?? this.stopSession();
    this.termination = termination;
    try {
      await termination;
    } catch (error) {
      if (this.termination === termination) this.termination = undefined;
      throw error;
    }
  }

  private async stopSession() {
    // A cutoff during launch must still stop the run once its ID arrives.
    await this.launch?.catch(() => undefined);
    if (!this.session) return;
    this.stopping = true;
    const stopped = AbortSignal.timeout(120_000);
    while (true) {
      await this.refresh(stopped);
      if (TERMINAL.has(this.session.status)) {
        // An interrupted run's follow-up may still be starting.
        if (!this.interruptedRunIds.has(this.session.latestRunId)) return;
      } else {
        // Cancel is idempotent; retry transient failures without resuming paid work.
        await this.client
          .request(
            `runs/${encodeURIComponent(this.session.latestRunId)}/cancel`,
            { method: "POST", signal: stopped },
          )
          .catch((error: unknown) => {
            if (!this.client.isTransient(error)) throw error;
          });
      }
      await delay(2000, undefined, { signal: stopped });
    }
  }

  async collectResults(signal: AbortSignal) {
    if (!this.session) throw new Error("Browser Use did not start a run.");
    const run = RunSchema.parse(
      await this.client.request(
        `runs/${encodeURIComponent(this.session.latestRunId)}`,
        { signal },
      ),
    );
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-run.json"),
      run,
    );
    // The final answer is reconciled; the workspace file survives a cutoff.
    const output = LenientReportSchema.safeParse(run.output);
    const report = output.success
      ? output.data
      : await this.readWorkspaceReport(signal);
    if (!report)
      throw new Error("Browser Use did not persist a structured report.");
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      ReportSchema.parse(report),
    );
    let costUsd: number | null = null;
    try {
      const cost = CostSchema.parse(
        await this.client.request(
          `sessions/${encodeURIComponent(this.session.sessionId)}/cost`,
          { signal },
        ),
      );
      costUsd = Number(cost.totalCostUsd);
      // Session cost covers model, search, browser and proxy usage.
      await writeJson(path.join(this.context.reportDirectory, "cost.json"), {
        ...cost,
        estimatedUsd: costUsd,
        costComplete: true,
      });
    } catch (error) {
      // A failed cost export must not discard otherwise usable findings.
      if (signal.aborted) throw error;
    }
    return {
      bugCount: report.bugs.length,
      costUsd,
      sessionId: this.session.sessionId,
    };
  }

  private async readWorkspaceReport(signal: AbortSignal) {
    if (!this.workspaceId) return undefined;
    const query = new URLSearchParams({ includeUrls: "true" });
    const { files } = z
      .object({
        files: z.array(
          z.object({ path: z.string(), url: z.string().nullish() }),
        ),
      })
      .parse(
        await this.client.request(
          `workspaces/${encodeURIComponent(this.workspaceId)}/files?${query}`,
          { signal },
        ),
      );
    // The agent chooses the folder (observed: outputs/), so match the file name.
    const file = files.find(
      (candidate) => path.posix.basename(candidate.path) === REPORT_FILE,
    );
    if (!file?.url) return undefined;
    const response = await fetch(file.url, { signal });
    if (!response.ok)
      throw new BrowserUseApiError(response.status, "workspace report");
    const parsed = LenientReportSchema.safeParse(
      JSON.parse(await response.text()),
    );
    return parsed.success ? parsed.data : undefined;
  }
}

export const browserUseAgent: EvalAgentDefinition = {
  name: "Browser Use",
  reportSubdirectory: "browser-use",
  // New Browser Use projects allow 10 concurrent browsers.
  concurrency: 5,
  config: {
    model: "browser-use-default",
    proxy: "none",
    retrieval: "prompt-restricted",
  },
  validateEnvironment() {
    BrowserUseClient.fromEnvironment();
  },
  create: (context) => new BrowserUseAgent(context),
};

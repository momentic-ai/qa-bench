import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

import {
  AgentContext,
  EvalAgent,
  EvalAgentDefinition,
} from "../../evals/agent";
import { getMoCost } from "../../evals/cost";
import { writeJson } from "../../evals/json-file";
import { runMoCommand, validateMoCli } from "../../evals/mo-cli";
import {
  MoCostSchema,
  MoFindingsSchema,
  MoReportSchema,
} from "../../evals/reports";
import {
  MIN_MO_SESSION_TIME_BUDGET_MINUTES,
  MoReadSchema,
  MoStatusSchema,
  isMoSessionReportReady,
} from "./cli-schemas";

// User-provided comparison guidance (spec §5) for Mo's eval input only; Codex chooses its own allocation.
export const MO_CONCURRENCY_GUIDANCE =
  "Maximize testing value and bug-finding efficiency. Concurrency should be utilized maximally as long as budget and relatively distinct areas, features, or flows remain, so that there is not too much concurrent modification.";

const SessionSchema = z.object({ sessionId: z.string().min(1) });

export class MoAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private sessionId: string | undefined;
  private completed = false;
  private finalizationMessage: string | undefined;
  private execution = new AbortController();
  private pending: Promise<unknown>[] = [];

  constructor(private context: AgentContext) {}

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    const { timeLimitMs } = this.context;
    const brief = `${message}

${MO_CONCURRENCY_GUIDANCE}`;
    onReady?.();
    const startArgs = ["start", brief];
    if (timeLimitMs) {
      const minutes = Math.ceil(timeLimitMs / 60_000);
      startArgs.push(
        "--time-budget",
        String(Math.max(MIN_MO_SESSION_TIME_BUDGET_MINUTES, minutes)),
      );
    }
    if (this.context.maxConcurrentSubAgents !== undefined) {
      startArgs.push(
        "--max-concurrency",
        String(this.context.maxConcurrentSubAgents),
      );
    }
    // The CLI/API cannot recover an ID if cancellation loses an accepted start response.
    const session = SessionSchema.parse(
      JSON.parse(await this.mo(startArgs, signal)),
    );
    this.sessionId = session.sessionId;
    process.stdout.write(
      `${this.context.fixture.name}: Mo session ${this.sessionId}\n`,
    );
    const executionSignal = AbortSignal.any([signal, this.execution.signal]);
    const completion = this.observeExecution(executionSignal).then(() => {
      executionSignal.throwIfAborted();
      this.completed = true;
    });
    // Attach a rejection handler immediately and drain it during termination.
    this.pending.push(Promise.allSettled([completion]));
    return { completion };
  }

  private async observeExecution(signal: AbortSignal) {
    const sessionId = this.requireSessionId();
    const answered = new Set<string>();
    while (!signal.aborted) {
      let status = MoStatusSchema.parse(
        JSON.parse(await this.mo(["status", sessionId], signal)),
      );
      if (
        status.attentionPending === undefined &&
        isMoSessionReportReady(status)
      ) {
        status = MoStatusSchema.parse(
          JSON.parse(await this.mo(["status", sessionId, "--full"], signal)),
        );
      }
      const display = status.displayState ?? status.state;
      const lifecycle = status.sessionState ?? status.state;
      if (
        display === "needs_you" ||
        lifecycle === "waitingOnUser" ||
        display === "blocked"
      ) {
        // Automated evals answer each input once without extending their budget.
        const read = MoReadSchema.parse(
          JSON.parse(
            await this.mo(
              [
                "read",
                sessionId,
                "--from",
                "start",
                "--timeout",
                "0",
                "--json",
              ],
              signal,
            ),
          ),
        );
        const inputId = read.pendingInput?.id;
        if (inputId) {
          if (!answered.has(inputId)) {
            const message =
              this.finalizationMessage ??
              "No additional information is available beyond the supplied evaluation brief and setup.";
            await this.mo(
              ["send", "--session-id", sessionId, "--wait", "0", message],
              signal,
            );
            answered.add(inputId);
          }
          await setTimeout(5000, undefined, { signal });
          continue;
        }
      }
      const ready = isMoSessionReportReady(status);
      const hasFindings =
        (status.counts?.bugs ?? status.findings?.bugs?.length ?? 0) > 0 ||
        (status.counts?.verdicts ?? status.findings?.verdicts?.length ?? 0) > 0;
      const failedDisplay = ["cancelled", "failed_start", "failed"].includes(
        display ?? "",
      );
      const terminalStop =
        lifecycle === "stopped" && display !== "waiting_on_agents";
      if (
        lifecycle === "failed" ||
        failedDisplay ||
        terminalStop ||
        (ready && display === "blocked" && !hasFindings)
      ) {
        throw new Error(`Mo session ${sessionId} needs attention: ${display}.`);
      }
      if (ready && lifecycle === "idle" && status.latestTurn?.completedAt) {
        signal.throwIfAborted();
        return;
      }
      await setTimeout(5000, undefined, { signal });
    }
    signal.throwIfAborted();
  }

  async send(message: string, signal: AbortSignal) {
    this.finalizationMessage = message;
    const delivery = this.mo(
      ["send", "--session-id", this.requireSessionId(), "--wait", "0", message],
      AbortSignal.any([signal, this.execution.signal]),
    );
    this.pending.push(Promise.allSettled([delivery]));
    await delivery;
  }

  async terminate() {
    this.execution.abort();
    try {
      if (!this.completed) await this.stopSession();
    } finally {
      await Promise.all(this.pending);
    }
  }

  private async stopSession() {
    if (!this.sessionId) {
      // Startup can fail before a remote session becomes available to stop.
      return;
    }
    await this.mo(
      ["stop", this.sessionId, "--subagents"],
      AbortSignal.timeout(30_000),
    );
  }

  async collectResults(signal: AbortSignal) {
    const sessionId = this.requireSessionId();
    const directory = this.context.reportDirectory;
    const exportSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(600_000),
    ]);
    await this.mo(
      ["report", sessionId, "--output", directory],
      exportSignal,
      600_000,
    );
    const report = MoReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
    );
    const bugs = MoFindingsSchema.parse(
      JSON.parse(
        await readFile(path.join(directory, report.findings.bugs), "utf8"),
      ),
    );
    let costUsd: number | null = null;
    try {
      const cost = MoCostSchema.parse(await getMoCost(sessionId, signal));
      await writeJson(path.join(directory, "cost.json"), cost);
      await writeJson(path.join(directory, "cost-observation.json"), {
        observedAt: new Date().toISOString(),
        pricingEstimated: cost.estimated ?? null,
        costComplete: false,
      });
      costUsd = cost.totals
        .filter((total) => total.currency === "mo_spend")
        .reduce((sum, total) => sum + total.amount, 0);
    } catch (err) {
      process.stderr.write(
        `${this.context.fixture.name}: could not collect Mo cost: ${err}\n`,
      );
      await writeJson(path.join(directory, "cost.json"), null);
    }
    return { sessionId, bugCount: bugs.length, costUsd };
  }

  private requireSessionId() {
    if (!this.sessionId) {
      // Commands cannot safely target an unidentified hosted session.
      throw new Error("Mo did not return a session ID.");
    }
    return this.sessionId;
  }

  private mo(args: string[], signal: AbortSignal, timeoutMs = 60_000) {
    return runMoCommand(args, { signal, timeoutMs });
  }
}

export const moAgent: EvalAgentDefinition = {
  name: "Mo",
  reportSubdirectory: "mo",
  concurrency: 2,
  async validateEnvironment() {
    await validateMoCli();
  },
  create: (context) => new MoAgent(context),
};

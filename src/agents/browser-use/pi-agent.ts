import { BrowserUse, type RunResult, Type } from "@browser_use/pi";
import { readFile } from "node:fs/promises";
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
import { LenientReportSchema, ReportSchema } from "../../evals/reports";
import { BrowserUseClient } from "./client";

const MODEL = "openai/gpt-6-luna";
const REASONING = "high";
const REPORT_FILE = "qa-report.json";
/** Without --minutes, match the longest published budget. */
const DEFAULT_TIMEOUT_MS = 120 * 60_000;

const PiReportSchema = Type.Object({
  bugs: Type.Array(
    Type.Object({
      name: Type.String(),
      summary: Type.String(),
      expected: Type.String(),
      actual: Type.String(),
      reproSteps: Type.Array(Type.String()),
    }),
  ),
  areasExplored: Type.Array(Type.String()),
  limitations: Type.Array(Type.String()),
});
const CloudBrowserSchema = z
  .object({
    id: z.string().min(1),
    cdpUrl: z.string().nullish(),
    browserCost: z.string().nullish(),
    proxyCost: z.string().nullish(),
  })
  .passthrough();

/** Runs the open-source Browser Use Pi SDK on this host against a Browser Use Cloud browser. */
export class BrowserUsePiAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private browserId: string | undefined;
  private agent: BrowserUse | undefined;
  private run: Promise<RunResult<unknown>> | undefined;
  private result: RunResult<unknown> | undefined;
  private readonly cancel = new AbortController();
  private termination: Promise<void> | undefined;

  constructor(
    private readonly context: AgentContext,
    private readonly client = BrowserUseClient.fromEnvironment(),
  ) {}

  private get workspace() {
    return path.join(this.context.runDirectory, "pi-workspace");
  }

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    const targetUrl = this.context.targetUrl;
    if (!targetUrl) throw new Error("Browser Use Pi requires a fixture URL.");
    // Provision the browser here, as Browser.cloud would, so its ID and cost stay reachable.
    const timeLimitMs = this.context.timeLimitMs ?? DEFAULT_TIMEOUT_MS;
    const browser = CloudBrowserSchema.parse(
      await this.client.request("browsers", {
        version: "v3",
        method: "POST",
        body: {
          timeout: Math.min(240, Math.ceil(timeLimitMs / 60_000) + 10),
          enableRecording: false,
          // Fixtures are public E2B hosts; a residential proxy only adds cost and latency.
          proxyCountryCode: null,
        },
      }),
    );
    this.browserId = browser.id;
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-pi-browser.json"),
      { id: browser.id },
    );
    if (!browser.cdpUrl)
      throw new Error("Browser Use Cloud returned no CDP URL.");
    signal.throwIfAborted();
    this.agent = await BrowserUse.create({
      model: MODEL,
      reasoning: REASONING,
      browser: { cdpUrl: browser.cdpUrl },
      dedicatedBrowser: true,
      workspace: this.workspace,
      // Mirrors --prevent-cheating's Browserbase limit; the Node worker's network is not sandboxed.
      allowedDomains: [targetUrl.hostname],
      telemetry: false,
      log: false,
    });
    const task = `${message}

${hostedAgentRules({
  retrievalTools: "fetch, require or import of remote code",
  isolation: "Browser pages are limited to the fixture host.",
  initialize: `call checkpoint('${REPORT_FILE}', report, { partial: true }) with empty bugs, areasExplored and limitations arrays. Each bug has name, summary, expected, actual and reproSteps (an array of strings).`,
  update: "Checkpoint the report again",
  finalize: "deliver the report with finish_from_js",
  closing:
    "The latest checkpoint is collected if the run is stopped at the deadline.",
})}`;
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-pi-launch.json"),
      { browserId: browser.id, model: MODEL, reasoning: REASONING, task },
    );
    const deadlineMs = onReady?.();
    signal.throwIfAborted();
    this.run = this.agent.run(task, {
      schema: PiReportSchema,
      // The time budget, not a step count, ends the run.
      maxSteps: 100_000,
      // Pi turns its last turn before this limit into delivery.
      timeoutMs: deadlineMs ? deadlineMs - Date.now() : timeLimitMs,
      signal: this.cancel.signal,
    });
    const run = this.run;
    return {
      completion: run.then(async (result) => {
        this.result = result;
        if (result.status === "error" && result.partial === undefined)
          throw new Error(`Browser Use Pi run failed: ${result.error}`);
      }),
    };
  }

  async send(message: string) {
    if (!this.run || this.result) return;
    try {
      this.agent?.steer(
        `${message} Checkpoint ${REPORT_FILE} now, then deliver the report with finish_from_js.`,
      );
    } catch {
      // The run already ended between turns; its result is collected as is.
    }
  }

  async terminate() {
    this.termination ??= this.stop();
    await this.termination;
  }

  private async stop() {
    try {
      this.cancel.abort();
      this.result ??= await this.run?.catch(() => undefined);
      await this.agent?.close();
    } finally {
      await this.stopBrowser();
    }
  }

  private async stopBrowser() {
    if (!this.browserId) return;
    const stopped = AbortSignal.timeout(120_000);
    while (true) {
      try {
        await this.client.request(
          `browsers/${encodeURIComponent(this.browserId)}`,
          {
            version: "v3",
            method: "PATCH",
            body: { action: "stop" },
            signal: stopped,
          },
        );
        return;
      } catch (error) {
        if (!this.client.isTransient(error)) throw error;
      }
      await delay(2000, undefined, { signal: stopped });
    }
  }

  async collectResults(signal: AbortSignal) {
    const result = this.result;
    if (!result) throw new Error("Browser Use Pi did not finish a run.");
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-pi-result.json"),
      result,
    );
    const report =
      result.status === "completed"
        ? LenientReportSchema.parse(result.output)
        : await this.partialReport(result);
    if (!report)
      throw new Error("Browser Use Pi did not checkpoint a structured report.");
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      ReportSchema.parse(report),
    );
    const modelUsd = result.usage.cost.total;
    let browserUsd: number | null = null;
    try {
      const browser = CloudBrowserSchema.parse(
        await this.client.request(
          `browsers/${encodeURIComponent(this.browserId ?? "")}`,
          { version: "v3", signal },
        ),
      );
      browserUsd =
        Number(browser.browserCost ?? 0) + Number(browser.proxyCost ?? 0);
    } catch (error) {
      // A failed browser cost export must not discard otherwise usable findings.
      if (signal.aborted) throw error;
    }
    const estimatedUsd = modelUsd + (browserUsd ?? 0);
    // Model cost is Pi's catalog estimate; browser and proxy cost come from Browser Use.
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), {
      modelUsd,
      browserUsd,
      estimatedUsd,
      costComplete: browserUsd !== null,
    });
    return {
      bugCount: report.bugs.length,
      costUsd: estimatedUsd,
      sessionId: this.browserId,
    };
  }

  /** An unfinished run keeps its latest published checkpoint; fall back to the file on disk. */
  private async partialReport(result: RunResult<unknown>) {
    if (result.status === "completed") return undefined;
    const published = LenientReportSchema.safeParse(result.partial?.value);
    if (published.success) return published.data;
    const text = await readFile(
      path.join(this.workspace, REPORT_FILE),
      "utf8",
    ).catch(() => undefined);
    if (text === undefined) return undefined;
    const saved = LenientReportSchema.safeParse(JSON.parse(text));
    return saved.success ? saved.data : undefined;
  }
}

export const browserUsePiAgent: EvalAgentDefinition = {
  name: "Browser Use Pi",
  reportSubdirectory: "browser-use-pi",
  concurrency: 5,
  config: {
    model: "gpt-6-luna",
    reasoning: REASONING,
    sdk: "browser-use-pi@5569fba",
    browser: "browser-use-cloud",
    proxy: "none",
    retrieval: "prompt-restricted",
  },
  validateEnvironment() {
    if (!process.env.OPENAI_API_KEY)
      throw new Error("OPENAI_API_KEY is required.");
    BrowserUseClient.fromEnvironment();
  },
  create: (context) => new BrowserUsePiAgent(context),
};

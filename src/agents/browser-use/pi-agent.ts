import {
  BrowserUse,
  type RunResult,
  Type,
  builtinModels,
} from "@browser_use/pi";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CodingAgentReportSchema,
  LenientReportSchema,
} from "../../evals/reports";
import { writeJson } from "../../shared/json-file";
import { hostedAgentRules } from "../hosted-agents";
import { openaiPrices } from "../model-pricing";
import {
  AgentContext,
  EvalAgent,
  EvalAgentDefinition,
  PI_MODELS,
  PiModel,
} from "../types";
import { BrowserUseBugVideos } from "./bug-videos";
import { BrowserUseClient, CloudBrowserSchema, browserUsd } from "./client";

/** Luna uses Browser Use's recommended effort; Sol and Terra match the Codex configuration. */
const REASONING = {
  "gpt-6-luna": "high",
  "gpt-6.1-sol": "medium",
  "gpt-6.1-terra": "medium",
} as const;
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
/** Models Pi's pinned catalog lacks. */
const UNLISTED_MODELS = {
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-terra": "GPT-6.1 Terra",
};

/** Pi's cost fields, from the per-million-token prices the Codex rows use. */
function piPrices(id: keyof typeof UNLISTED_MODELS, tier: "short" | "long") {
  const { input, cachedInput, cacheWrite, output } = openaiPrices[id][tier];
  return { input, output, cacheRead: cachedInput, cacheWrite };
}

/** Register the GPT-6.1 models from gpt-6-sol's definition at their own prices. */
function piModels() {
  const models = builtinModels();
  const base = models.getModel("openai", "gpt-6-sol");
  if (!base) throw new Error("Pi's catalog has no gpt-6-sol definition.");
  const unlisted = new Map(
    Object.entries(UNLISTED_MODELS).map(([id, name]) => {
      const model = id as keyof typeof UNLISTED_MODELS;
      return [
        id,
        {
          ...base,
          id,
          name,
          cost: {
            ...piPrices(model, "short"),
            tiers: base.cost.tiers?.map((tier) => ({
              ...tier,
              ...piPrices(model, "long"),
            })),
          },
        },
      ];
    }),
  );
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) =>
    (provider === "openai" && unlisted.get(id)) || getModel(provider, id);
  return models;
}

/** Runs the open-source Browser Use Pi SDK on this host against a Browser Use Cloud browser. */
export class BrowserUsePiAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private browserId: string | undefined;
  private networkPolicyId: string | undefined;
  private readonly videos: BrowserUseBugVideos | undefined;
  private agent: BrowserUse | undefined;
  private run: Promise<RunResult<unknown>> | undefined;
  private result: RunResult<unknown> | undefined;
  private readonly cancel = new AbortController();
  private termination: Promise<void> | undefined;

  constructor(
    private readonly context: AgentContext,
    private readonly model: PiModel,
    private readonly options: PiOptions = {},
    private readonly client = BrowserUseClient.fromEnvironment(),
  ) {
    if (options.recordBugs)
      this.videos = new BrowserUseBugVideos(
        context.runDirectory,
        context.reportDirectory,
      );
  }

  private get workspace() {
    return path.join(this.context.runDirectory, "pi-workspace");
  }

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    if (!this.context.targetUrl)
      throw new Error("Browser Use Pi requires a fixture URL.");
    // Provision the browser here, as Browser.cloud would, so its ID and cost stay reachable.
    const timeLimitMs = this.context.timeLimitMs ?? DEFAULT_TIMEOUT_MS;
    if (this.options.preventCheating)
      this.networkPolicyId = await this.client.createFixturePolicy(
        this.context.targetUrl,
        signal,
      );
    const browser = CloudBrowserSchema.parse(
      await this.client.request("browsers", {
        method: "POST",
        body: {
          // Browser Use's proxy answers blocked hosts with 403, so the CDP connection survives.
          ...(this.networkPolicyId
            ? { networkPolicyId: this.networkPolicyId }
            : {}),
          timeout: Math.min(240, Math.ceil(timeLimitMs / 60_000) + 10),
          enableRecording: false,
          // Fixtures are public E2B hosts; a residential proxy only adds cost and latency.
          proxyCountryCode: null,
          // Without it the browser ignores viewport emulation and window resizing, so the
          // responsive widths in the brief are unreachable.
          allowResizing: true,
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
    this.videos?.start(
      browser.cdpUrl,
      async () => {
        const text = await readFile(
          path.join(this.workspace, REPORT_FILE),
          "utf8",
        );
        return LenientReportSchema.parse(JSON.parse(text));
      },
      2000,
    );
    this.agent = await BrowserUse.create({
      model: `openai/${this.model}`,
      models: piModels(),
      reasoning: REASONING[this.model],
      browser: { cdpUrl: browser.cdpUrl },
      dedicatedBrowser: true,
      workspace: this.workspace,
      // No allowedDomains: Pi's policy closes the whole CDP connection when it cannot arm a
      // tab blocked by a dialog. The worker can fetch any URL with or without a policy.
      telemetry: false,
      log: false,
    });
    const task = `${message}

${hostedAgentRules({
  retrievalTools: "fetch, require or import of remote code",
  initialize: `call checkpoint('${REPORT_FILE}', report, { partial: true }) with empty bugs, areasExplored and limitations arrays. Each bug has name, summary, expected, actual and reproSteps (an array of strings).`,
  update: "Checkpoint the report again",
  finalize: "deliver the report with finish_from_js",
  closing:
    "The latest checkpoint is collected if the run is stopped at the deadline.",
})}`;
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-pi-launch.json"),
      {
        browserId: browser.id,
        model: this.model,
        reasoning: REASONING[this.model],
        task,
      },
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
      await this.videos?.stop();
      await this.agent?.close();
    } finally {
      try {
        if (this.browserId) await this.client.stopBrowser(this.browserId);
      } finally {
        if (this.networkPolicyId)
          await this.client.deletePolicy(this.networkPolicyId);
      }
    }
  }

  async collectResults(signal: AbortSignal) {
    const result = this.result;
    if (!result) throw new Error("Browser Use Pi did not finish a run.");
    await writeJson(
      path.join(this.context.reportDirectory, "browser-use-pi-result.json"),
      result,
    );
    const saved =
      result.status === "completed"
        ? LenientReportSchema.parse(result.output)
        : await this.partialReport(result);
    if (!saved)
      throw new Error("Browser Use Pi did not checkpoint a structured report.");
    const report = this.videos
      ? await this.videos.attach(saved, signal)
      : saved;
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      CodingAgentReportSchema.parse(report),
    );
    const modelUsd = result.usage.cost.total;
    let browserCost: number | null = null;
    try {
      browserCost = browserUsd(
        await this.client.getBrowser(this.browserId ?? "", signal),
      );
    } catch (error) {
      // A failed browser cost export must not discard otherwise usable findings.
      if (signal.aborted) throw error;
    }
    const estimatedUsd = modelUsd + (browserCost ?? 0);
    // Model cost is Pi's catalog estimate; browser and proxy cost come from Browser Use.
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), {
      modelUsd,
      browserUsd: browserCost,
      estimatedUsd,
      costComplete: browserCost !== null,
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

type PiOptions = { preventCheating?: boolean; recordBugs?: boolean };

export function browserUsePiAgent(
  model: PiModel = PI_MODELS[0],
  options: PiOptions = {},
): EvalAgentDefinition {
  return {
    name: "Browser Use Pi",
    reportSubdirectory: "browser-use-pi",
    concurrency: 5,
    config: {
      model,
      reasoning: REASONING[model],
      sdk: "browser-use-pi@5569fba",
      browser: "browser-use-cloud",
      proxy: "none",
      retrieval: "prompt-restricted",
      ...(options.preventCheating ? { preventCheating: true } : {}),
      ...(options.recordBugs ? { recordBugs: true } : {}),
    },
    validateEnvironment() {
      if (!process.env.OPENAI_API_KEY)
        throw new Error("OPENAI_API_KEY is required.");
      BrowserUseClient.fromEnvironment();
    },
    create: (context) => new BrowserUsePiAgent(context, model, options),
  };
}

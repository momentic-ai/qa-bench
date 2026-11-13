import { Fixture } from "./types";

export const MO_EFFORTS = ["low", "medium", "high", "max"] as const;
export type MoEffort = (typeof MO_EFFORTS)[number];
/** The first model of each list is the default. */
export const CODEX_MODELS = ["gpt-6.1-sol", "gpt-6.1-terra"] as const;
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export type AgentContext = {
  agentName?: string;
  fixture: Fixture;
  targetUrl?: URL;
  /** Set only when --time-limit or --minutes is passed. */
  timeLimitMs?: number;
  maxConcurrentSubAgents?: number;
  effort?: MoEffort;
  reportDirectory: string;
  runDirectory: string;
};

export type AgentResults = {
  bugCount: number;
  costUsd: number | null;
  sessionId?: string;
};

export type AgentExecution = {
  /** Settles when execution finishes or fails; the runner owns this promise. */
  completion: Promise<void>;
};

/** Execution and messaging must settle on abort; termination owns cleanup. */
export interface EvalAgent {
  /** Opt in to preparation outside the budget; call onReady before dispatch. */
  readonly preparesEnvironment?: true;
  /** Call onReady immediately before task dispatch; it starts the budget and returns its deadline. */
  start(
    message: string,
    signal: AbortSignal,
    deadlineMs?: number,
    onReady?: () => number,
  ): Promise<AgentExecution | void>;
  /** Resolve on delivery, without waiting for the model to comply. */
  send(message: string, signal: AbortSignal): Promise<void>;
  /** Request parent/child stop; await local persistence needed for collection, not hosted child drain. */
  terminate(): Promise<void>;
  /** Read/export saved results only. Never invoke a model to produce a report. */
  collectResults(signal: AbortSignal): Promise<AgentResults>;
}

export type Browser = "browserbase" | "kernel" | "local";

export type EvalAgentDefinition = {
  name: string;
  reportSubdirectory: string;
  concurrency: number;
  /** Run settings recorded once in duration.json; merge labels and separates runs by them. */
  config?: Record<string, string | boolean>;
  validateEnvironment(
    timeLimitMs: number,
    fixtures?: Fixture[],
  ): void | Promise<void>;
  create(
    context: AgentContext,
    signal: AbortSignal,
  ): EvalAgent | Promise<EvalAgent>;
};

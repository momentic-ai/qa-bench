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
import { DevinApiError, DevinQaClient } from "./qa-client";
import {
  fixtureHostnames,
  prepareSecurityProfile,
  verifyCleanOrganization,
} from "./qa-security";

export const SessionSchema = z.object({
  session_id: z.string().min(1),
  url: z.url(),
  status: z.string(),
  status_detail: z.string().nullable().optional(),
  devin_mode: z.string().nullable().optional(),
  structured_output: z.unknown().optional(),
  security_profile: z.object({ profile_id: z.string() }).nullish(),
});

/** No mode/model/effort override: resolve the new organization's Devin default. */
export function sessionRequest(
  prompt: string,
  profileId: string,
  title: string,
) {
  return {
    title,
    prompt,
    repos: [],
    knowledge_ids: [],
    secret_ids: [],
    session_links: [],
    resumable: false,
    security_profile: { profile_id: profileId },
    structured_output_required: true,
    structured_output_schema: z.toJSONSchema(ReportSchema, {
      target: "draft-7",
    }),
    tags: ["momentic-qa-bench"],
  };
}

export class DevinQaAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private session: z.infer<typeof SessionSchema> | undefined;
  private readonly client: DevinQaClient;
  private report: z.infer<typeof ReportSchema> | undefined;
  private stopping = false;
  private termination: Promise<void> | undefined;
  private launch: Promise<void> | undefined;

  constructor(
    private readonly context: AgentContext,
    client = DevinQaClient.fromEnvironment(),
  ) {
    this.client = client;
  }

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    if (!this.context.targetUrl)
      throw new Error("Devin QA requires a fixture URL.");
    await verifyCleanOrganization(this.client, signal);
    const profile = await prepareSecurityProfile(
      this.client,
      fixtureHostnames(this.context.targetUrl),
      signal,
    );
    await writeJson(
      path.join(this.context.reportDirectory, "devin-security.json"),
      profile,
    );
    const prompt = `${message}

${hostedAgentRules({
  retrievalTools: "web_search, DeepWiki (including devin_ask_wiki_question)",
  privateSources: ["prior sessions", "knowledge notes", "playbooks"],
  isolation:
    "The network profile restricts the VM, but some built-in retrieval tools remain available. Their availability is not permission to use them. Do not bypass the restrictions, request broader network access, change security settings, or create child sessions.",
  initialize:
    "initialize provide_structured_output with empty bugs, areasExplored and limitations arrays. Keep is_final=false while testing.",
  update: "Update structured output",
  finalize: "mark is_final=true",
  closing: "A final chat reply does not submit findings.",
})}`;
    const title = `momentic-qa-${randomUUID()}`;
    await writeJson(
      path.join(this.context.reportDirectory, "devin-launch-intent.json"),
      { title, profileId: profile.profile_id, prompt },
    );
    onReady?.();
    signal.throwIfAborted();
    // Do not cancel a launch in flight: its ID is needed to terminate paid work.
    this.launch = this.createSession(prompt, profile.profile_id, title);
    await this.launch;
    await this.saveSession();
    const confirmation = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    while (!this.session?.security_profile) {
      await delay(1000, undefined, { signal: confirmation });
      await this.refresh(confirmation);
    }
    if (this.session.security_profile.profile_id !== profile.profile_id)
      throw new Error("Devin did not confirm the requested security profile.");
    signal.throwIfAborted();
    return { completion: this.observe(signal) };
  }

  private async createSession(
    prompt: string,
    profileId: string,
    title: string,
  ) {
    try {
      this.session = SessionSchema.parse(
        await this.client.request("sessions", {
          method: "POST",
          body: sessionRequest(prompt, profileId, title),
        }),
      );
    } catch (error) {
      // A timed-out POST may have created a session. Recover its ID without retrying creation.
      const sessions = await this.client.list("sessions");
      const matches = sessions.filter(
        (value) =>
          z.object({ title: z.string().nullable() }).parse(value).title ===
          title,
      );
      if (matches.length === 1) this.session = SessionSchema.parse(matches[0]);
      throw error;
    }
  }

  async send(message: string, signal: AbortSignal) {
    if (!this.session || this.stopping)
      throw new Error("Devin QA session is not active.");
    await this.client.request(
      `sessions/${encodeURIComponent(this.session.session_id)}/messages`,
      {
        method: "POST",
        body: { message: `${message} Update provide_structured_output now.` },
        signal,
      },
    );
  }

  private async observe(signal: AbortSignal) {
    while (!this.stopping) {
      signal.throwIfAborted();
      await this.refresh(signal);
      if (
        this.session?.status === "exit" ||
        this.session?.status_detail === "finished" ||
        this.session?.status_detail === "waiting_for_user"
      ) {
        if (!this.report)
          throw new Error("Devin finished without a valid structured report.");
        return;
      }
      if (
        this.session?.status_detail &&
        this.session.status_detail !== "working"
      )
        throw new Error(`Devin QA stopped: ${this.session.status_detail}.`);
      if (this.session?.status === "error")
        throw new Error("Devin QA session failed.");
      await delay(10_000, undefined, { signal });
    }
  }

  private async refresh(signal?: AbortSignal) {
    if (!this.session) return;
    this.session = SessionSchema.parse(
      await this.client.request(
        `sessions/${encodeURIComponent(this.session.session_id)}`,
        { signal },
      ),
    );
    await this.saveSession();
    if (this.session.structured_output != null) {
      this.report = ReportSchema.parse(this.session.structured_output);
      await writeJson(
        path.join(this.context.reportDirectory, "report.json"),
        this.report,
      );
    }
  }

  private async saveSession() {
    await writeJson(
      path.join(this.context.reportDirectory, "devin-session.json"),
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
    // A cutoff during launch must still reap the session once its ID arrives.
    await this.launch?.catch(() => undefined);
    if (!this.session) return;
    this.stopping = true;
    // DELETE is replay-safe; retry transient failures without resuming paid work.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.request(
          `sessions/${encodeURIComponent(this.session.session_id)}`,
          { method: "DELETE" },
        );
        break;
      } catch (error) {
        const transient =
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError") ||
          (error instanceof DevinApiError &&
            (error.status === 429 || error.status >= 500));
        if (!transient || attempt === 2) throw error;
        await delay(1000 * (attempt + 1));
      }
    }
    const stopped = AbortSignal.timeout(120_000);
    while (true) {
      await this.refresh(stopped);
      if (this.session.status === "exit") return;
      await delay(2000, undefined, { signal: stopped });
    }
  }

  async collectResults(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.report)
      throw new Error("Devin QA did not persist a structured report.");
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      this.report,
    );
    // ACUs and quota usage are not a complete USD charge. Never invent a conversion.
    return {
      bugCount: this.report.bugs.length,
      costUsd: null,
      sessionId: this.session?.session_id,
    };
  }
}

export const devinQaAgent: EvalAgentDefinition = {
  name: "Devin QA",
  reportSubdirectory: "devin-qa",
  concurrency: 1,
  config: {
    model: "devin-default",
    effort: "devin-default",
    network: "fixture-only",
    retrieval: "prompt-restricted",
  },
  async validateEnvironment(_timeLimitMs, fixtures) {
    if (fixtures?.some((fixture) => fixture.type !== "full-app"))
      throw new Error("Devin QA supports full-app web fixtures only.");
    await verifyCleanOrganization(DevinQaClient.fromEnvironment());
  },
  create: (context) => new DevinQaAgent(context),
};

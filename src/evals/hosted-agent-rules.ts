/** Provider-specific wording for the rules shared by agents whose retrieval cannot be sandboxed (Devin, Browser Use). */
export type HostedAgentRules = {
  /** Built-in retrieval tools named in the research ban. */
  retrievalTools: string;
  /** Provider memory the agent must not consult, beyond the shared sources. */
  privateSources?: string[];
  /** Provider isolation notes, placed before the coverage-limitation rule. */
  isolation?: string;
  /** Completes "Before testing, ": how to create the empty report. */
  initialize: string;
  /** How to save the report, e.g. "Update structured output". */
  update: string;
  /** How to submit the final report, e.g. "mark is_final=true". */
  finalize: string;
  closing: string;
};

const SOURCES = [
  "GitHub",
  "GitLab",
  "Codeberg",
  "repository contents or history",
  "issues",
  "pull requests",
  "fixes",
  "public bug reports",
  "benchmark files",
  "ground truth",
  "previous reports",
];

/** Rules appended to the shared bugbash brief; only the save and submit mechanics differ by provider. */
export function hostedAgentRules(rules: HostedAgentRules) {
  const sources = [...SOURCES, ...(rules.privateSources ?? [])];
  const isolation = rules.isolation ? `${rules.isolation} ` : "";
  return `Only inspect the running fixture. Find bugs through your own browser exploration and reproduce every reported failure in this session.

Do not use ${rules.retrievalTools}, or any other search, browsing, shell, API, or MCP tool to retrieve information outside the fixture. Do not consult ${sources.slice(0, -1).join(", ")}, or ${sources.at(-1)}. Do not infer findings from remembered bug reports; confirm failures against the running fixture.

${isolation}If a flow needs a blocked external resource, record it as a coverage limitation.

Before testing, ${rules.initialize} ${rules.update} immediately after each verified bug and completed workflow. Include complete reproduction steps and observed evidence in each finding. Keep areasExplored and limitations current, and ${rules.finalize} only when the work is complete or the budget ends. ${rules.closing}`;
}

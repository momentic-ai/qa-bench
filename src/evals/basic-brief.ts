import { Fixture } from "./types";

export function basicBugbashBrief(
  url: URL,
  timeLimitMs: number,
  fixture: Fixture,
  browserTool: "Playwright MCP" | "agent-browser" = "Playwright MCP",
) {
  const area = fixture.productArea;
  return `Find bugs in this app: ${url.href}
${fixture.authentication ?? `Sign in with username ${fixture.username} and password ${fixture.password}.`}
${area ? `Test only ${area.name}: ${area.scope}. Entry points: ${area.entryPoints.map((entry) => `${entry.path}: ${entry.directions}`).join("; ")}` : ""}
You have ${timeLimitMs / 60_000} minutes. Use ${browserTool}.`;
}

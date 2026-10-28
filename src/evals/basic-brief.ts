import { Fixture } from "./types";

export function basicBugbashBrief(url: URL, fixture: Fixture) {
  const area = fixture.productArea;
  return `Find bugs in this app: ${url.href}
${fixture.authentication ?? `Sign in with username ${fixture.username} and password ${fixture.password}.`}
${area ? `Test only ${area.name}: ${area.scope}. Entry points: ${area.entryPoints.map((entry) => `${entry.path}: ${entry.directions}`).join("; ")}` : ""}
Use Playwright MCP.`;
}

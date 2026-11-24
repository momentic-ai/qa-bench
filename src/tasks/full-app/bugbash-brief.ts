import { fixtureAuthentication } from "../../fixtures/accounts";
import { Fixture } from "../../fixtures/types";

export function bugbashBrief(
  url: URL,
  timeLimitMs: number | undefined,
  fixture: Fixture,
  browserTool?:
    | "Playwright MCP"
    | "agent-browser"
    | "e2e"
    | "Devin native browser",
) {
  const sections = [
    `Find bugs in this app: ${url.href}`,
    `${fixtureAuthentication(fixture)}\nDo not change account credentials.`,
  ];
  const area = fixture.productArea;
  if (area) {
    sections.push(`Test only the ${area.name} area: ${area.scope}
Entry points:
${area.entryPoints.map((entry) => `- ${entry.path}: ${entry.directions}`).join("\n")}`);
  }
  // An area fixture inherits its app's flag, so only the area's own setting applies to it.
  const responsive = area
    ? (area.testResponsiveness ?? false)
    : (fixture.testResponsiveness ?? false);
  if (responsive) {
    sections.push(
      "Also test at desktop, tablet and mobile widths (about 1440, 768 and 390 CSS pixels).",
    );
  }
  sections.push(
    "Do not read benchmark files, ground truth, or previous eval reports.",
  );
  if (timeLimitMs) sections.push(`You have ${timeLimitMs / 60_000} minutes.`);
  if (browserTool) sections.push(`Use ${browserTool}.`);
  return sections.join("\n\n");
}

import { Fixture, FixtureAccount } from "./types";

export function bugbashBrief(
  url: URL,
  timeLimitMs: number | undefined,
  fixture: Fixture,
  browserTool?: "Playwright MCP" | "agent-browser" | "Devin native browser",
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

export function fixtureAccounts(fixture: Fixture): FixtureAccount[] {
  const accounts = [
    {
      name: "fixture",
      username: fixture.username,
      password: fixture.password,
      role: "Primary fixture account",
    },
    ...(fixture.additionalAccounts ?? []),
  ];
  if (
    new Set(accounts.map((account) => account.name)).size !== accounts.length ||
    new Set(accounts.map((account) => account.username.toLowerCase())).size !==
      accounts.length
  ) {
    throw new Error(`${fixture.name}: fixture accounts must be distinct.`);
  }
  return accounts;
}

export function fixtureAuthentication(fixture: Fixture): string {
  const authentication =
    fixture.authentication ??
    (fixture.username
      ? `Sign in with username ${fixture.username} and password ${fixture.password}.`
      : "");
  if (!fixture.additionalAccounts) return authentication;
  return `${authentication}

Three accounts are available for testing interactions between users:
${fixtureAccounts(fixture)
  .map(
    (account) =>
      `- ${account.name}: username ${account.username}, password ${account.password}; ${account.role}.`,
  )
  .join("\n")}`;
}

import { Fixture, FixtureAccount } from "./types";

export const EXPLORATION_GUIDANCE = `Continue while meaningful exploration remains. Aim to find every distinct, reproducible bug you can by exhausting all discoverable application flows, including alternate paths. Keep exploring after each finding. Finish once those flows are exhausted and findings are verified, or when instructed to finalize.

Untested areas and failed jobs belong in coverage metadata, never in bug findings.`;

export function productAreaGuidance(fixture: Fixture) {
  if (!fixture.productArea) return "";
  const area = fixture.productArea;
  return `Test only the ${area.name} product area: ${area.scope}.
Entry points and navigation:
${area.entryPoints.map((entry) => `- ${entry.path}: ${entry.directions}`).join("\n")}
Use authentication and other features only for prerequisites. Cover this feature's actions and behaviors, including its lists, search/filters, detail controls and tabs, and persistence. Do not broaden into unrelated features. Preserve incidental observed findings outside this area, but do not start exploring those other features. Pass this scope and these directions to every subagent.`;
}

export const RESPONSIVENESS_GUIDANCE =
  "Also test responsiveness: exercise the flows at desktop, tablet and mobile viewport widths (for example about 1440, 768 and 390 CSS pixels wide), checking that content and controls stay visible and usable at each width.";

export function explorationGuidance(fixture: Fixture) {
  const area = productAreaGuidance(fixture);
  // An area fixture inherits its app's flag, so only the area's own setting applies to it.
  const responsive = fixture.productArea
    ? (fixture.productArea.testResponsiveness ?? false)
    : (fixture.testResponsiveness ?? false);
  let sections = [EXPLORATION_GUIDANCE];
  if (area) {
    sections = [
      area,
      EXPLORATION_GUIDANCE.replace(
        "all discoverable application flows",
        "all discoverable flows within this product area",
      ),
    ];
  }
  if (responsive) sections.push(RESPONSIVENESS_GUIDANCE);
  return sections.join("\n\n");
}

const EVIDENCE_RESTRICTIONS =
  "Do not read benchmark files, ground truth, or previous eval reports. Pass all evidence restrictions to every subagent.";

// Give every evaluation arm the obligations already present in Mo's product prompts.
export const SHARED_QA_OBLIGATIONS = `Report each bug with expected and actual behavior, evidence of the observed failure, and ordered reproduction steps that start from a clear page, screen, or precondition. Write the steps so someone else can follow them on a fresh copy of the app, including how to create any data they need.

Protect shared state: give parallel work separate data where practical, and do not modify data another active agent is using. After checking a change's downstream effects, restore shared data you modified so others can keep testing it.`;

export function bugbashBrief(url: URL, timeLimitMs: number, fixture: Fixture) {
  let evaluationContext =
    "This is a long-duration evaluation of your ability to find true bugs.";
  if (timeLimitMs > 30 * 60_000) {
    evaluationContext +=
      "\nExplore product areas end to end with the depth and breadth of a multi-hour test session.";
  }
  return `Bug bash ${url.href}. Find as many distinct, reproducible product bugs as you can. Do not change account authentication details.

${evaluationContext}

${explorationGuidance(fixture)}

The site is hosted on E2B. Explore visible user journeys with the browser. Do not use application source code.

Report only verified bugs. If you verify no bugs, report no bugs.

${SHARED_QA_OBLIGATIONS}

${EVIDENCE_RESTRICTIONS}`;
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
  .join("\n")}
Use separate browser sessions for different users. Use the primary fixture account by default; coordinate shared test data when testing collaboration or permissions. Do not change these accounts' credentials.`;
}

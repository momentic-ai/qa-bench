import { Fixture, FixtureAccount } from "./types";

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

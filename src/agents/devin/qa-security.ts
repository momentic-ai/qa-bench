import { createHash } from "node:crypto";
import { z } from "zod";

import { DevinApiError, DevinQaClient } from "./qa-client";

const ProfileSchema = z.object({
  profile_id: z.string().min(1),
  name: z.string(),
  enforcement_level: z.literal("mandatory"),
  net_policy: z.object({
    allow: z.array(z.object({ hostname: z.string() }).strict()),
  }),
  mcp_config: z.object({ servers: z.array(z.string()).length(0) }),
  devin_mcp_read_only: z.literal(true),
  git_access_level: z.literal("read_only"),
  remove_github_cli_token: z.literal(true),
});

/** Only fixture hosts are eligible; never allow a shared E2B domain wildcard. */
export function fixtureHostnames(url: URL) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^[a-z0-9-]+\.e2b\.app$/.test(url.hostname)
  )
    throw new Error("Devin QA requires an exact HTTPS E2B fixture hostname.");
  return [url.hostname];
}

export function profileRequest(hostnames: string[]) {
  const hash = createHash("sha256")
    .update(JSON.stringify(hostnames))
    .digest("hex")
    .slice(0, 20);
  return {
    name: `momentic-qa-${hash}`,
    enforcement_level: "mandatory",
    net_policy: { allow: hostnames.map((hostname) => ({ hostname })) },
    mcp_config: { servers: [] },
    devin_mcp_read_only: true,
    git_access_level: "read_only",
    remove_github_cli_token: true,
  };
}

export function verifyProfile(value: unknown, hostnames: string[]) {
  const profile = ProfileSchema.parse(value);
  const allowed = profile.net_policy.allow
    .map((entry) => entry.hostname)
    .sort();
  if (JSON.stringify(allowed) !== JSON.stringify([...hostnames].sort()))
    throw new Error(
      "Devin QA security profile allows unexpected network destinations.",
    );
  return profile;
}

export async function prepareSecurityProfile(
  client: DevinQaClient,
  hostnames: string[],
  signal?: AbortSignal,
) {
  const request = profileRequest(hostnames);
  const profiles = await client.list("security-profiles", signal, true);
  const existing = profiles.find(
    (value) =>
      z.object({ name: z.string() }).parse(value).name === request.name,
  );
  if (existing) return verifyProfile(existing, hostnames);
  // A duplicate name can result from concurrent fixture preparation. Never retry other writes.
  try {
    return verifyProfile(
      await client.request("security-profiles", {
        method: "POST",
        body: request,
        beta: true,
        signal,
      }),
      hostnames,
    );
  } catch (error) {
    if (!(error instanceof DevinApiError) || error.status !== 409) throw error;
    const profiles = await client.list("security-profiles", signal, true);
    return verifyProfile(
      profiles.find(
        (value) =>
          z.object({ name: z.string() }).parse(value).name === request.name,
      ),
      hostnames,
    );
  }
}

export async function verifyCleanOrganization(
  client: DevinQaClient,
  signal?: AbortSignal,
) {
  for (const endpoint of ["repositories", "knowledge/notes"]) {
    if ((await client.list(endpoint, signal)).length)
      throw new Error(
        `Devin QA requires a clean organization: remove ${endpoint} before running.`,
      );
  }
  const platform = z
    .object({
      outpost_pool_id: z.string().nullable(),
      platform: z.string().nullable(),
    })
    .parse(await client.request("default-platform", { beta: true, signal }));
  if (platform.outpost_pool_id)
    throw new Error(
      "Devin QA requires Devin-managed VMs; Outposts do not enforce network profiles.",
    );
  // Also verifies security-profile permissions before any paid fixture is allocated.
  await client.list("security-profiles", signal, true);
}

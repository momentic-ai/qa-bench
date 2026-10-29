import assert from "node:assert/strict";
import { it } from "node:test";

import { sessionRequest } from "./qa-agent";
import { fixtureHostnames, profileRequest, verifyProfile } from "./qa-security";

it("limits network access to one fixture hostname, rejecting shared domains and credential tricks", () => {
  assert.deepEqual(
    fixtureHostnames(new URL("https://3000-fixture123.e2b.app/path")),
    ["3000-fixture123.e2b.app"],
  );
  for (const url of [
    "https://github.com",
    "https://e2b.app",
    "https://evil.e2b.app.example.com",
    "https://github.com@3000-fixture123.e2b.app",
    "http://3000-fixture123.e2b.app",
  ])
    assert.throws(() => fixtureHostnames(new URL(url)));
});

it("rejects profiles that widen network access or leave external MCP tools enabled", () => {
  const hosts = ["3000-fixture123.e2b.app"];
  const profile = {
    ...profileRequest(hosts),
    profile_id: "security-profile-test",
  };
  assert.equal(verifyProfile(profile, hosts).profile_id, profile.profile_id);
  for (const change of [
    { net_policy: null },
    { net_policy: { allow: [{ hostname: "*.e2b.app" }] } },
    {
      net_policy: {
        allow: [...profile.net_policy.allow, { hostname: "github.com" }],
      },
    },
    { net_policy: { allow: [{ hostname: hosts[0], ipv4: "0.0.0.0/0" }] } },
    { enforcement_level: "recommended" },
    { mcp_config: null },
    { mcp_config: { servers: ["deepwiki"] } },
    { devin_mcp_read_only: false },
    { remove_github_cli_token: false },
    { git_access_level: "read_write" },
  ])
    assert.throws(() => verifyProfile({ ...profile, ...change }, hosts));
});

it("starts disposable sessions with the required profile and no inherited repositories or model override", () => {
  const request = sessionRequest("test", "profile", "title");
  assert.deepEqual(request.security_profile, { profile_id: "profile" });
  assert.deepEqual(request.repos, []);
  assert.deepEqual(request.knowledge_ids, []);
  assert.deepEqual(request.secret_ids, []);
  assert.deepEqual(request.session_links, []);
  assert.equal(request.resumable, false);
  assert.equal("devin_mode" in request, false);
  assert.equal("bypass_approval" in request, false);
});

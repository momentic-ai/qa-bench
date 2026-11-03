import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";

import { AgentBrowserSessions } from "./agent-browser-sessions";

const exec = promisify(execFile);
const OutputSchema = z.object({
  config: z.object({ cdp: z.string() }),
  socket: z.string(),
  namespace: z.string(),
  screenshot: z.string(),
  configPath: z.string(),
  args: z.array(z.string()),
  override: z.string().optional(),
});
const wrapper = path.join(import.meta.dirname, "agent-browser-wrapper.mjs");

it("isolates concurrent CLI owners, restores their connection, and releases only the stopped owner", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qa-ownership-test-"));
  const command = path.join(workspace, "cli.mjs");
  await writeFile(
    command,
    `import {readFile} from 'node:fs/promises';
    if(process.argv[2] !== 'close') console.log(JSON.stringify({
      config:JSON.parse(await readFile(process.env.AGENT_BROWSER_CONFIG,'utf8')),
      socket:process.env.AGENT_BROWSER_SOCKET_DIR,
      namespace:process.env.AGENT_BROWSER_NAMESPACE,
      screenshot:process.env.AGENT_BROWSER_SCREENSHOT_DIR,
      configPath:process.env.AGENT_BROWSER_CONFIG,
      args:process.argv.slice(2),override:process.env.AGENT_BROWSER_CDP}));`,
  );
  const allocations: { agentId: string; id: string }[] = [];
  const released: string[] = [];
  const sessions = new AgentBrowserSessions(workspace, command, workspace, {
    async create(agentId) {
      const id = String(allocations.length + 1);
      allocations.push({ agentId, id });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id, connectUrl: `wss://browser.invalid/${id}` };
    },
    async releaseAgent(agentId) {
      released.push(agentId);
    },
  });
  const endpoint = await sessions.start();
  const run = async (
    agentId: string,
    args = ["--session", "default", "snapshot"],
  ) => {
    const result = await exec(process.execPath, [wrapper, ...args], {
      env: {
        ...process.env,
        QA_BENCH_BROWSER_BROKER: endpoint,
        CODEX_THREAD_ID: agentId,
        QA_BENCH_BROWSER_AGENT_ID: "",
        AGENT_BROWSER_CDP: "wss://unowned.invalid",
      },
    });
    return OutputSchema.parse(JSON.parse(result.stdout));
  };
  try {
    for (const id of ["parent", "child-1", "child-2"]) sessions.register(id);
    const [parent, child, sibling, sameChild] = await Promise.all([
      run("parent"),
      run("child-1"),
      run("child-2"),
      run("child-1"),
    ]);
    assert.equal(allocations.length, 3);
    assert.deepEqual(child, sameChild);
    for (const key of [
      "socket",
      "namespace",
      "screenshot",
      "configPath",
    ] as const) {
      assert.equal(new Set([parent[key], child[key], sibling[key]]).size, 3);
    }
    assert.equal(
      new Set([parent.config.cdp, child.config.cdp, sibling.config.cdp]).size,
      3,
    );
    assert.equal(parent.override, undefined);
    await writeFile(
      child.configPath,
      JSON.stringify({ executablePath: "/unowned/chrome" }),
    );
    assert.deepEqual((await run("child-1")).config, child.config);
    // Ordinary input text must not be confused with the connection command.
    assert.deepEqual((await run("parent", ["fill", "@e1", "connect"])).args, [
      "fill",
      "@e1",
      "connect",
    ]);
    for (const args of [
      ["--cdp=ws://unowned", "snapshot"],
      ["--config", "bad.json", "snapshot"],
      ["--session", "default", "connect", "9222"],
    ]) {
      await assert.rejects(
        run("parent", args),
        /configuration overrides are disabled/,
      );
    }
    await assert.rejects(run("unknown"), /local fallback is disabled/);
    assert.equal(allocations.length, 3);
    await sessions.release("child-1");
    assert.deepEqual(released, ["child-1"]);
    assert.deepEqual(await run("parent"), parent);
    assert.deepEqual(await run("child-2"), sibling);
    sessions.register("child-1");
    const resumed = await run("child-1");
    assert.notEqual(resumed.config.cdp, child.config.cdp);
    assert.notEqual(resumed.namespace, child.namespace);
    assert.notEqual(resumed.socket, child.socket);
    const audit = await readFile(
      path.join(workspace, "browser-ownership.json"),
      "utf8",
    );
    assert.ok(audit.includes('"rejected-override"'));
    assert.ok(!audit.includes("wss://"));
  } finally {
    await sessions.close();
    await rm(workspace, { recursive: true, force: true });
  }
  assert.deepEqual(released.sort(), [
    "child-1",
    "child-1",
    "child-2",
    "parent",
  ]);
});

it("fails closed on provider errors and releases allocations that finish during shutdown", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qa-allocation-test-"));
  const command = path.join(workspace, "cli.mjs");
  await writeFile(command, "");
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started: (() => void) | undefined;
  const allocating = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releases: string[] = [];
  const sessions = new AgentBrowserSessions(workspace, command, workspace, {
    async create(agentId) {
      if (agentId === "failed") throw new Error("secret-provider-credential");
      started?.();
      await pending;
      return { id: "pending", connectUrl: "wss://secret-connection.invalid" };
    },
    async releaseAgent(agentId) {
      releases.push(agentId);
    },
  });
  const endpoint = await sessions.start();
  const request = (agentId: string) =>
    fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ action: "environment", agentId }),
    });
  try {
    sessions.register("failed");
    const failure = await request("failed");
    assert.equal(failure.status, 502);
    assert.ok(!(await failure.text()).includes("secret"));
    sessions.register("pending");
    const response = request("pending");
    await allocating;
    const closing = sessions.close();
    finish?.();
    assert.equal((await response).status, 502);
    await closing;
    assert.deepEqual(releases.sort(), ["failed", "pending"]);
  } finally {
    finish?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

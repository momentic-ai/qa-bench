import {
  ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  chromiumExecutable,
  playwrightCoreDirectory,
} from "../agents/local-browser";
import { runCommand } from "../evals/command";
import { EgressProxy, EgressRule } from "./egress-proxy";
import { REPO_ROOT, sandboxImage } from "./image";

const exec = promisify(execFile);
const TOOLS = "/opt/tools";
const PROXY = "http://127.0.0.1:3128";
const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ToolEnv = Record<string, string | undefined>;

/**
 * Where a run's agent and browser tools execute: the host, or a sandbox
 * container that sees only the run's files and reaches only allowed hosts.
 * Tools are named by their path in this checkout; the runtime maps them.
 */
export interface ToolRuntime {
  /** The Node.js binary that runs tool scripts. */
  readonly node: string;
  /** The proxy a browser must use, for browsers that ignore the environment's. */
  readonly browserProxy?: string;
  /** The path a tool under this checkout has where it runs. */
  path(hostPath: string): string;
  /** A PATH that puts `directories` (as the tools see them) first. */
  pathEnv(directories: string[]): string;
  spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env: ToolEnv },
  ): ChildProcessWithoutNullStreams;
  run(
    command: string,
    args: string[],
    options: {
      env: ToolEnv;
      input?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<string>;
  /** Makes the host's 127.0.0.1:<port> reachable at the same address. */
  forward(port: number): Promise<void>;
  /** Playwright MCP's Chromium, as the tools see it. */
  chromium(): Promise<string>;
  /** A short scratch directory for the tools; Unix socket paths can't be long. */
  temporaryDirectory(): Promise<string>;
  close(): Promise<void>;
}

export class HostRuntime implements ToolRuntime {
  readonly node = process.execPath;
  private temporaryDirectories: string[] = [];

  path(hostPath: string) {
    return hostPath;
  }

  pathEnv(directories: string[]) {
    return [...directories, process.env.PATH ?? ""].join(path.delimiter);
  }

  spawn(
    command: string,
    args: string[],
    { cwd, env }: { cwd?: string; env: ToolEnv },
  ) {
    return spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  run(
    command: string,
    args: string[],
    options: {
      env: ToolEnv;
      input?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) {
    return runCommand(command, args, options);
  }

  async forward() {}

  async chromium() {
    return chromiumExecutable();
  }

  async temporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), "qa-bench-tools-"));
    this.temporaryDirectories.push(directory);
    return directory;
  }

  async close() {
    await Promise.all(
      this.temporaryDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}

/** One container per run, with no network beyond the egress proxy. */
export class SandboxRuntime implements ToolRuntime {
  readonly node = "node";
  readonly browserProxy = PROXY;
  private name = `qa-bench-${randomUUID().slice(0, 12)}`;

  private constructor(
    private directory: string,
    private proxy: EgressProxy,
  ) {}

  /** Starts the container with `workspace` and `runDirectory` mounted at their host paths. */
  static async start({
    workspace,
    runDirectory,
    rules,
  }: {
    workspace: string;
    runDirectory: string;
    rules: EgressRule[];
  }) {
    const directory = await mkdtemp(path.join(tmpdir(), "qa-bench-egress-"));
    const proxy = new EgressProxy(
      path.join(directory, "egress.sock"),
      rules,
      path.join(runDirectory, "egress-denied.log"),
    );
    await proxy.start();
    const runtime = new SandboxRuntime(directory, proxy);
    try {
      const home = path.join(runDirectory, "home");
      await mkdir(home, { recursive: true });
      const user =
        process.getuid && process.getgid
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : [];
      await exec("docker", [
        "run",
        "--detach",
        "--rm",
        "--init",
        "--name",
        runtime.name,
        "--label",
        "qa-bench.sandbox=1",
        "--network",
        "none",
        // Only root uses it, below; the agent runs as the host user without it.
        "--cap-add",
        "NET_ADMIN",
        // Chromium crashes with Docker's default 64 MB /dev/shm.
        "--shm-size=1g",
        ...user,
        "--volume",
        `${workspace}:${workspace}`,
        "--volume",
        `${runDirectory}:${runDirectory}`,
        "--volume",
        `${directory}:/run/qa-bench`,
        "--env",
        `HOME=${home}`,
        ...["HTTPS_PROXY", "https_proxy"].flatMap((name) => [
          "--env",
          `${name}=${PROXY}`,
        ]),
        // Forwarded harness ports are local; everything else goes through the proxy.
        ...["NO_PROXY", "no_proxy"].flatMap((name) => [
          "--env",
          `${name}=127.0.0.1,localhost`,
        ]),
        "--env",
        "NODE_USE_ENV_PROXY=1",
        await sandboxImage(),
        "node",
        "/opt/sandbox/relay.mjs",
        "keep",
      ]);
      await runtime.ready(3128);
      // Chrome treats a container with only loopback as offline (navigator.onLine is
      // false), so give it an interface that leads nowhere.
      await exec("docker", [
        "exec",
        "--user",
        "0",
        runtime.name,
        "sh",
        "-c",
        "ip link add qa0 type dummy && ip link set qa0 up && ip addr add 10.255.255.1/32 dev qa0",
      ]);
      return runtime;
    } catch (err) {
      await runtime.close();
      throw err;
    }
  }

  path(hostPath: string) {
    if (hostPath === process.execPath) return this.node;
    // A bare command like "node" is looked up on the container's PATH.
    if (!path.isAbsolute(hostPath)) return hostPath;
    const relative = path.relative(REPO_ROOT, hostPath);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(`${hostPath} isn't part of the sandbox's tools.`);
    return path.posix.join(TOOLS, ...relative.split(path.sep));
  }

  pathEnv(directories: string[]) {
    return [...directories, SYSTEM_PATH].join(":");
  }

  private execArgs(options: { cwd?: string; env: ToolEnv; input: boolean }) {
    return [
      "exec",
      ...(options.input ? ["--interactive"] : []),
      ...(options.cwd ? ["--workdir", options.cwd] : []),
      // Values come from docker's own environment, so secrets stay off the command line.
      ...Object.keys(this.toolEnv(options.env)).flatMap((name) => [
        "--env",
        name,
      ]),
      this.name,
    ];
  }

  // The container sets HOME and the proxy; the caller's host values don't apply there.
  private toolEnv(env: ToolEnv) {
    return Object.fromEntries(
      Object.entries(env).filter(
        ([name, value]) =>
          value !== undefined &&
          !["HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR"].includes(name),
      ),
    ) as Record<string, string>;
  }

  private dockerEnv(env: ToolEnv) {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      ...this.toolEnv(env),
    };
  }

  spawn(
    command: string,
    args: string[],
    { cwd, env }: { cwd?: string; env: ToolEnv },
  ) {
    return spawn(
      "docker",
      [
        ...this.execArgs({ cwd, env, input: true }),
        this.path(command),
        ...args,
      ],
      {
        env: this.dockerEnv(env),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  run(
    command: string,
    args: string[],
    options: {
      env: ToolEnv;
      input?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) {
    return runCommand(
      "docker",
      [
        ...this.execArgs({
          env: options.env,
          input: options.input !== undefined,
        }),
        this.path(command),
        ...args,
      ],
      { ...options, env: this.dockerEnv(options.env) },
    );
  }

  async forward(port: number) {
    this.proxy.allow({ host: "127.0.0.1", port });
    await exec("docker", [
      "exec",
      "--detach",
      this.name,
      "node",
      "/opt/sandbox/relay.mjs",
      "forward",
      String(port),
    ]);
    await this.ready(port);
  }

  async chromium() {
    return this.run(
      "node",
      [
        "-p",
        `require(${JSON.stringify(this.path(playwrightCoreDirectory()))}).chromium.executablePath()`,
      ],
      { env: {} },
    );
  }

  async temporaryDirectory() {
    return "/tmp";
  }

  private async ready(port: number) {
    const marker = path.join(this.directory, `ready-${port}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await access(marker).then(
          () => true,
          () => false,
        )
      )
        return;
      await delay(100);
    }
    throw new Error(`Sandbox relay for port ${port} didn't start.`);
  }

  async close() {
    await exec("docker", ["rm", "--force", this.name]).catch(() => {});
    await this.proxy.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}

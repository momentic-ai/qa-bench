import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { EgressProxy, EgressRule } from "./egress-proxy";
import { sandboxImage } from "./image";

const exec = promisify(execFile);
// WORKDIR in sandbox/Dockerfile.
const TOOLS = "/opt/tools";
const PROXY_PORT = 3128;
/** The proxy every process in the container uses; browsers take it as a flag. */
export const CONTAINER_PROXY = `http://127.0.0.1:${PROXY_PORT}`;
/** Where the container sees the runtime's directory. */
export const CONTAINER_DIRECTORY = "/run/qa-bench";

/** One container per run, with no network beyond the egress proxy. */
export class SandboxRuntime {
  private name = `qa-bench-${randomUUID().slice(0, 12)}`;

  private constructor(
    /** The host side of CONTAINER_DIRECTORY. */
    readonly directory: string,
    private proxy: EgressProxy,
    private mounts: string[],
  ) {}

  /**
   * Starts the container with the run and report directories mounted at their host paths.
   * `readOnly` are folders in them that only the harness writes.
   */
  static async start({
    runDirectory,
    reportDirectory,
    rules,
    readOnly = [],
  }: {
    runDirectory: string;
    reportDirectory: string;
    rules: EgressRule[];
    readOnly?: string[];
  }) {
    const directory = await mkdtemp(path.join(tmpdir(), "qa-bench-egress-"));
    const log = path.join(runDirectory, "egress-denied.log");
    await writeFile(log, "", { flag: "a" });
    const proxy = new EgressProxy(
      path.join(directory, "egress.sock"),
      rules,
      log,
    );
    await proxy.start();
    const runtime = new SandboxRuntime(directory, proxy, [
      runDirectory,
      reportDirectory,
    ]);
    try {
      const home = path.join(runDirectory, "home");
      for (const folder of [home, ...readOnly])
        await mkdir(folder, { recursive: true });
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
        ...[runDirectory, reportDirectory].flatMap((mount) => [
          "--volume",
          `${mount}:${mount}`,
        ]),
        ...[log, ...readOnly].flatMap((mount) => [
          "--volume",
          `${mount}:${mount}:ro`,
        ]),
        "--volume",
        `${directory}:${CONTAINER_DIRECTORY}`,
        "--env",
        `HOME=${home}`,
        ...["HTTPS_PROXY", "https_proxy"].flatMap((name) => [
          "--env",
          `${name}=${CONTAINER_PROXY}`,
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
      await runtime.ready(PROXY_PORT);
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

  /** Runs `command` in the container from the tools directory, with its output on the harness's. */
  exec(command: string, args: string[], env: Record<string, string>) {
    return spawn(
      "docker",
      [
        "exec",
        "--workdir",
        TOOLS,
        // Values come from docker's own environment, so secrets stay off the command line.
        ...Object.keys(env).flatMap((name) => ["--env", name]),
        this.name,
        command,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
          ...env,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
  }

  /** Makes the host's 127.0.0.1:<port> reachable at the same address. */
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
    // Symlinks and pipes the agent left could redirect or stall the harness's later writes and reads.
    for (const mount of this.mounts)
      for (const entry of await readdir(mount, {
        recursive: true,
        withFileTypes: true,
      }))
        if (!entry.isFile() && !entry.isDirectory())
          await rm(path.join(entry.parentPath, entry.name));
  }
}

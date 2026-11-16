import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  trimOutput?: boolean;
  killGroupOnExit?: boolean;
};

/** Await process exit even on abort, and kill descendants of a stuck command. */
export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
) {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), "mo-eval-command-"));
  const outputPath = path.join(directory, "stdout");
  try {
    const output = await open(outputPath, "w", 0o600);
    try {
      // Released CLIs can exit before piped stdout drains; a regular file preserves large JSON responses.
      return await captureCommand(
        command,
        args,
        options,
        output.fd,
        outputPath,
      );
    } finally {
      await output.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function captureCommand(
  command: string,
  args: string[],
  {
    signal,
    timeoutMs = 60_000,
    env,
    cwd,
    input,
    trimOutput = true,
    killGroupOnExit = false,
  }: CommandOptions,
  outputFd: number,
  outputPath: string,
) {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    env,
    cwd,
    detached: process.platform !== "win32",
    stdio: ["pipe", outputFd, "pipe"],
  });
  let stderr = "";
  let failure: unknown;
  let forceKill: NodeJS.Timeout | undefined;
  const kill = (killSignal: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") {
        // CLI children belong to the same process group on Unix.
        process.kill(-child.pid, killSignal);
      } else {
        // Windows has no negative-PID process-group API.
        child.kill(killSignal);
      }
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) {
        // An already-exited process is harmless; other kill failures must be reported.
        failure ??= err;
      }
    }
  };
  const abort = () => {
    failure ??= signal?.reason ?? new Error(`${command} timed out.`);
    kill("SIGTERM");
    forceKill ??= setTimeout(() => kill("SIGKILL"), 1000);
  };
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  child.on("error", (err) => {
    failure ??= err;
  });
  child.stdin?.on("error", (err) => {
    failure ??= err;
  });
  child.stdin?.end(input);
  let stdout: string;
  try {
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    if (failure !== undefined) {
      // Report cancellation and transport failures after the subprocess is reaped.
      throw failure;
    }
    if (code !== 0) {
      // Failed CLI operations carry stderr without discarding earlier saved findings.
      throw new Error(
        `${command} ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`,
      );
    }
    stdout = await readFile(outputPath, "utf8");
  } finally {
    if (forceKill !== undefined || killGroupOnExit) {
      // Background descendants can outlive a successful shell exit and retain no stdio handles.
      kill("SIGKILL");
    }
    clearTimeout(timer);
    clearTimeout(forceKill);
    signal?.removeEventListener("abort", abort);
  }
  if (failure !== undefined) throw failure;
  return trimOutput ? stdout.trim() : stdout;
}

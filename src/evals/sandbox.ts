import { Sandbox } from "@e2b/code-interpreter";

import { deleteFixtureSandbox } from "../fixtures/e2b";

export type SandboxCleanup = {
  signal: AbortSignal;
  track: (sandbox: Sandbox) => void;
  deleteSandbox: (sandbox: Sandbox) => Promise<void>;
  dispose: () => Promise<void>;
};

export function setupSandboxCleanup(
  options: { signal?: AbortSignal } = {},
): SandboxCleanup {
  const controller = new AbortController();
  const parent = options.signal;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const active = new Set<Sandbox>();
  const deletions = new Map<Sandbox, Promise<void>>();

  function deleteSandbox(sandbox: Sandbox) {
    let deletion = deletions.get(sandbox);
    if (!deletion) {
      // Every caller shares one deletion task so cleanup cannot race itself.
      deletion = Promise.resolve().then(() =>
        deleteFixtureSandbox(sandbox.sandboxId).then(() => {
          active.delete(sandbox);
        }),
      );
      deletions.set(sandbox, deletion);
    }
    return deletion;
  }

  function interrupt(exitCode: number) {
    if (controller.signal.aborted) {
      // Repeated signals must not bypass awaited agent shutdown and report export.
      return;
    }
    process.exitCode = exitCode;
    controller.abort();
    // Workers stop agents and collect saved findings before deleting their fixtures.
  }

  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  return {
    signal: controller.signal,
    track(sandbox: Sandbox) {
      active.add(sandbox);
    },
    deleteSandbox,
    async dispose() {
      try {
        const outcomes = await Promise.allSettled(
          [...active].map(deleteSandbox),
        );
        const failures: unknown[] = [];
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") failures.push(outcome.reason);
        }
        if (failures.length > 0) {
          // Attempt all sandbox deletions before surfacing cleanup failures.
          throw new AggregateError(failures, "Could not delete E2B sandboxes.");
        }
      } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        parent?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

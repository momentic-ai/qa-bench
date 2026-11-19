import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import { z } from "zod";

import { BrowserCost } from "../browser-cost";
import type { CodingAgentSettings } from "../coding-agent";
import type { CodingAgentContext } from "../types";

// In CONTAINER_DIRECTORY.
export const CONFIG_FILE = "config.json";
/** Where the driver reaches the harness, through the container's relay. */
export const CONTROL_PORT = 3129;

/** What the driver needs to build the run's agent. */
export type DriverConfig = {
  settings: CodingAgentSettings;
  broker?: string;
  context: Omit<CodingAgentContext, "targetUrl"> & { targetUrl?: string };
};

/** An EvalAgent call from the harness, or the cancellation of one's signal. */
export const RequestSchema = z.union([
  z.object({
    id: z.number(),
    method: z.enum(["start", "send"]),
    message: z.string(),
  }),
  z.object({ id: z.number(), method: z.literal("terminate") }),
  z.object({
    id: z.number(),
    method: z.literal("collectResults"),
    browserCost: z.custom<BrowserCost>().optional(),
  }),
  z.object({ cancel: z.number() }),
]);

/** A call's outcome, or the end of the agent's execution. */
export const ReplySchema = z.union([
  z.object({
    id: z.number(),
    result: z.unknown(),
    error: z.string().optional(),
  }),
  z.object({ completed: z.literal(true), error: z.string().optional() }),
]);

/** Messages are JSON lines. */
export function onMessage(socket: Duplex, handle: (message: unknown) => void) {
  createInterface({ input: socket }).on("line", (line) =>
    handle(JSON.parse(line)),
  );
}

export function sendMessage(socket: Duplex, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

const playwright = createRequire(
  createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
);

const PlaywrightSchema = z.object({
  chromium: z.custom<{ executablePath(): string }>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "executablePath" in value &&
      typeof value.executablePath === "function",
  ),
});

/** Playwright MCP's copy of playwright-core, whose Chromium the local browser tools use. */
export function playwrightCoreDirectory() {
  return path.dirname(playwright.resolve("playwright-core/package.json"));
}

export function chromiumExecutable() {
  return PlaywrightSchema.parse(
    playwright("playwright-core"),
  ).chromium.executablePath();
}

export async function validateLocalChromium() {
  const executable = chromiumExecutable();
  try {
    await access(executable);
  } catch {
    throw new Error(
      `Local Chromium is missing at ${executable}. Install it with: node ${path.join(path.dirname(playwright.resolve("playwright-core/package.json")), "cli.js")} install --with-deps chromium`,
    );
  }
}

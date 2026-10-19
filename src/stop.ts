import { parseArgs } from "node:util";

import { deleteFixtureSandbox } from "./fixtures/e2b";

try {
  const { positionals } = parseArgs({ allowPositionals: true, strict: true });
  if (positionals.length !== 1 || !positionals[0].trim()) {
    throw new Error(
      "Use pnpm stop-fixture <sandbox-id> with the Sandbox ID printed by start.",
    );
  }
  const id = positionals[0];
  const killed = await deleteFixtureSandbox(id);
  if (killed) process.stdout.write(`${id} stopped\n`);
  else process.stdout.write(`${id} already stopped\n`);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}

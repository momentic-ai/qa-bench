import { cp } from "node:fs/promises";
import path from "node:path";

import { AgentCost, Browser } from "../../../agents/types";
import { TestingBrowser } from "../../testing-browser";
import {
  addE2ECost,
  e2eInstructions,
  prepareE2E,
  validateE2E,
} from "./workspace";

export class E2E extends TestingBrowser {
  private journal: string | undefined;
  private workspace: string | undefined;

  static async validate(browser: Browser) {
    await validateE2E();
    // e2e downloads its own pinned Chromium.
    if (browser !== "local") await super.validate(browser);
  }

  protected async setup(workspace: string) {
    this.workspace = workspace;
    this.instructions = e2eInstructions(this.context.fixture);
    if (!this.context.targetUrl)
      throw new Error("Agent fixture URL is missing.");
    this.journal = path.join(
      this.context.runDirectory,
      "e2e-model-calls.jsonl",
    );
    return {
      env: await prepareE2E({
        workspace,
        skillOwner: this.options.skillOwner,
        fixture: this.context.fixture,
        targetUrl: this.context.targetUrl,
        model: this.options.e2eModel,
        journal: this.journal,
        broker:
          this.options.browser === "local"
            ? undefined
            : (await this.connect()).env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
      }),
    };
  }

  async cost(model: AgentCost | null, modelComplete: boolean) {
    const cost = await super.cost(model, modelComplete);
    return this.journal ? addE2ECost(cost, this.journal) : cost;
  }

  async close() {
    const { workspace } = this;
    try {
      if (this.journal && workspace)
        // Keep the bug-bash config, charters, repro tests and e2e reports as evidence.
        await cp(
          workspace,
          path.join(this.context.runDirectory, "e2e-workspace"),
          {
            recursive: true,
            filter: (entry) =>
              ![".agents", ".claude", "node_modules"].includes(
                path.relative(workspace, entry).split(path.sep)[0],
              ),
          },
        );
    } finally {
      await super.close();
    }
  }
}

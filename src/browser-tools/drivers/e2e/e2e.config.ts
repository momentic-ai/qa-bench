import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

import { meteredModel, readE2ESetup } from "./harness";

const { targetUrl, broker, model, journal, credentials } = readE2ESetup();

export default {
  targets: [
    {
      engine: broker ? web({ connect: { cdpEndpoint: () => broker } }) : web(),
      app: { url: targetUrl },
    },
  ],
  // Each explore and repro records a replay for reviewing its findings.
  video: "on",
  credentials,
  agents: {
    default: {
      model: meteredModel(model, journal),
      providerOptions:
        model.provider === "openai"
          ? { openai: { reasoningEffort: "medium" } }
          : { anthropic: { effort: "medium" } },
    },
  },
} satisfies E2EConfig;

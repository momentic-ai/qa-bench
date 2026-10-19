import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";

import { FindingSchema, GroundTruthSchema } from "./reports";

export { FindingSchema, GroundTruthSchema as AppGroundTruthSchema };
export type Finding = z.infer<typeof FindingSchema>;
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export const ProductAreaSchema = z
  .object({
    name: z.string().min(1),
    scope: z.string().min(1),
    entryPoints: z
      .array(
        z
          .object({
            path: z.string().startsWith("/"),
            directions: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    /** Ask both agents to test desktop, tablet and mobile widths; set where the area's catalog has responsive bugs. */
    testResponsiveness: z.boolean().optional(),
  })
  .strict();

export const FixtureAccountSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    username: z.string().min(1),
    password: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();
export type FixtureAccount = z.infer<typeof FixtureAccountSchema>;

export const FixtureSchema = z
  .object({
    runtimeEnvironment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
      .optional(),
    port: z.number().int().positive(),
    username: z.string(),
    password: z.string(),
    additionalAccounts: z.array(FixtureAccountSchema).length(2).optional(),
    entryPath: z.string().startsWith("/").optional(),
    authentication: z.string().optional(),
    productArea: ProductAreaSchema.optional(),
    /** Whole-app counterpart of productArea.testResponsiveness. */
    testResponsiveness: z.boolean().optional(),
    e2bTemplate: z.string().optional(),
    sandboxResources: z
      .object({ cpu: z.number(), memory: z.number(), disk: z.number() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const FixtureRecipeSchema = FixtureSchema.partial().extend({
  extends: z.string().min(1).optional(),
});

const deploymentFile = z.object({ source: z.string(), target: z.string() });
export const FixtureDeploymentSchema = z.object({
  compose: z.array(deploymentFile),
  composeFiles: z.array(z.string()),
});
export type FixtureDeployment = z.infer<typeof FixtureDeploymentSchema>;
export type FixtureDeploymentFile = z.infer<typeof deploymentFile>;

export type Fixture = z.infer<typeof FixtureSchema> & {
  type: "full-app";
  name: string;
  directory: string;
  deployment: FixtureDeployment;
  groundTruthFile: string;
  fullAppGroundTruthFile?: string;
};
export type FullAppFixture = Fixture;
export type WebFixture = Fixture;

export type BenchmarkSandbox = Sandbox;

export interface BenchmarkReport {
  bugs: Finding[];
  flags?: Finding[];
  costUsd: number | null;
  costComplete: boolean;
  durationSeconds: number;
}

export interface BenchmarkAgent {
  name: string;
  reportDirectory: string;
  getReport(directory: string): Promise<BenchmarkReport>;
}

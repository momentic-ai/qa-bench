import path from "node:path";

import { FixtureDeployment, FixtureDeploymentFile } from "../evals/types";

export type DeploymentLayer = { directory: string; files: string[] };

function layerFiles(
  layer: DeploymentLayer,
  root: "app" | "case",
): FixtureDeploymentFile[] {
  const files: FixtureDeploymentFile[] = [];
  const add = (file: string, target: string) =>
    files.push({ source: path.join(layer.directory, file), target });
  if (root === "app" && layer.files.includes("fixture.json"))
    add("fixture.json", "fixture.json");
  for (const file of layer.files) {
    if (["compose.yaml", "docker-compose.yaml"].includes(file))
      add(file, `${root}/compose/compose.yaml`);
    if (!file.startsWith("runtime/")) continue;
    add(file, path.posix.join(root, file.slice("runtime/".length)));
  }
  return files;
}

export function resolveDeployment(
  layers: DeploymentLayer[],
): FixtureDeployment {
  const compose = [
    ...new Map(
      layers
        .flatMap((layer, index) =>
          layerFiles(layer, index === 0 ? "app" : "case"),
        )
        .map((file) => [file.target, file]),
    ).values(),
  ].sort((a, b) => a.target.localeCompare(b.target));
  return {
    compose,
    composeFiles: [
      "docker-compose.yaml",
      "app/compose/compose.yaml",
      "case/compose/compose.yaml",
    ].filter((target) => compose.some((file) => file.target === target)),
  };
}

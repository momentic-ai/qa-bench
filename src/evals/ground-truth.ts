import { loadGroundTruth } from "./reports";
import { Fixture } from "./types";

export function readGroundTruth(fixture: Fixture) {
  return loadGroundTruth(fixture.groundTruthFile);
}

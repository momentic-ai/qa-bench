import { Assessment } from "./assessment";

export function partitionAreaAssessment(
  area: Assessment,
  remaining: Assessment,
  findingIndices: number[],
) {
  const outsideCanonical = new Set([
    ...remaining.matches.map((match) => findingIndices[match.findingIndex]),
    ...remaining.invalidMatches.map(
      (match) => findingIndices[match.findingIndex],
    ),
  ]);
  const remainingDuplicates = remaining.duplicates.map((duplicate) => ({
    ...duplicate,
    findingIndex: findingIndices[duplicate.findingIndex],
    canonicalFindingIndex: findingIndices[duplicate.canonicalFindingIndex],
  }));
  const remainingCanonical = new Map(
    remainingDuplicates.map((duplicate) => [
      duplicate.findingIndex,
      duplicate.canonicalFindingIndex,
    ]),
  );
  const duplicates = [
    ...area.duplicates.map((duplicate) => ({
      ...duplicate,
      canonicalFindingIndex:
        remainingCanonical.get(duplicate.canonicalFindingIndex) ??
        duplicate.canonicalFindingIndex,
    })),
    ...remainingDuplicates,
  ];
  const outsideDuplicates = duplicates.filter((duplicate) =>
    outsideCanonical.has(duplicate.canonicalFindingIndex),
  );
  const inAreaDuplicates = duplicates.filter(
    (duplicate) => !outsideCanonical.has(duplicate.canonicalFindingIndex),
  );
  const inAreaDuplicateIndices = new Set(
    inAreaDuplicates.map((duplicate) => duplicate.findingIndex),
  );
  const originalUnverifiedIndices = new Set(
    area.unverified.map((finding) => finding.findingIndex),
  );
  const unverified = area.unverified.filter(
    (finding) => !inAreaDuplicateIndices.has(finding.findingIndex),
  );
  for (const duplicate of outsideDuplicates) {
    if (originalUnverifiedIndices.has(duplicate.findingIndex)) continue;
    unverified.push({
      findingIndex: duplicate.findingIndex,
      reason: `Duplicate of a known finding outside this product area: ${duplicate.reason}`,
    });
  }
  return {
    assessment: { ...area, duplicates: inAreaDuplicates, unverified },
    outsideDuplicates,
    outsideKnownHits: remaining.matches.length,
    outsideKnownInvalid: remaining.invalidMatches.length,
    unverified:
      unverified.length - outsideCanonical.size - outsideDuplicates.length,
  };
}

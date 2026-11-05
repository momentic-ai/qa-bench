import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { Assessment } from "../grading/assessment";
import { Finding, KnownBug } from "./reports";

export type OutsideAreaReview = {
  knownHits: { findingIndex: number; reference: KnownBug; reason: string }[];
  knownInvalid: { findingIndex: number; reference: Finding; reason: string }[];
  duplicates: Assessment["duplicates"];
};

const MediaSchema = z.object({ artifactId: z.string() });

function text(value: string) {
  return value.replace(/[\\`*_{}[\]<>#|]/g, "\\$&");
}

function link(label: string, from: string, to: string) {
  const target = path
    .relative(from, to)
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/");
  return `[${text(label)}](${target})`;
}

function findingFile(index: number) {
  return `${String(index + 1).padStart(4, "0")}.md`;
}

async function exists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function evidenceLines(finding: Finding, directory: string) {
  const from = path.join(directory, "findings");
  const lines: string[] = [];
  for (const filename of [
    "report.json",
    "grading.json",
    "outside-area-grading.json",
    "bugs.json",
    "accepted-findings.json",
    "native-report.json",
  ]) {
    if (await exists(path.join(directory, filename))) {
      // Link only existing exports; these retain native IDs without copying model transcripts.
      lines.push(`- ${link(filename, from, path.join(directory, filename))}`);
    }
  }
  for (const field of ["recording", "screenshot"]) {
    const media = MediaSchema.safeParse(finding[field]);
    if (media.success) {
      // Hosted Mo media may not be downloaded; preserve its identifier without inventing a URL.
      lines.push(`- ${field} artifact ID: ${text(media.data.artifactId)}`);
    }
  }
  for (const field of ["id", "conversationId", "investigatorConversationId"]) {
    const value = finding[field];
    if (typeof value === "string") lines.push(`- ${field}: ${text(value)}`);
  }
  return [...new Set(lines)];
}

function findingDetails(finding: Finding) {
  return [
    "## Summary",
    "",
    text(finding.summary),
    "",
    "## Expected",
    "",
    text(finding.expected),
    "",
    "## Actual",
    "",
    text(finding.actual),
    "",
    "## Reproduction",
    "",
    ...finding.reproSteps.map(
      (step, i) => `${i + 1}. ${text(step).replaceAll("\n", "\n   ")}`,
    ),
    "",
  ];
}

export async function writeReviewArtifacts({
  reportDirectory,
  report,
  assessment,
  groundTruth,
  knownInvalid,
  outsideArea,
}: {
  reportDirectory: string;
  report: { bugs: Finding[] };
  assessment: Assessment;
  groundTruth: KnownBug[];
  knownInvalid: Finding[];
  outsideArea?: OutsideAreaReview;
}): Promise<string> {
  const directory = path.join(reportDirectory, "findings");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const rows: string[] = [];
  const reviewNote =
    "Unverified means human review is required. The model cannot approve a new bug or add a known-invalid reference.";
  for (const [index, finding] of report.bugs.entries()) {
    const hit = assessment.matches.find((item) => item.findingIndex === index);
    const invalid = assessment.invalidMatches.find(
      (item) => item.findingIndex === index,
    );
    const duplicate = assessment.duplicates.find(
      (item) => item.findingIndex === index,
    );
    const unverified = assessment.unverified.find(
      (item) => item.findingIndex === index,
    );
    const severity = assessment.severities.find(
      (item) => item.findingIndex === index,
    );
    const outsideHit = outsideArea?.knownHits.find(
      (item) => item.findingIndex === index,
    );
    const outsideInvalid = outsideArea?.knownInvalid.find(
      (item) => item.findingIndex === index,
    );
    const outsideDuplicate = outsideArea?.duplicates.find(
      (item) => item.findingIndex === index,
    );
    if (!severity || !(hit || invalid || duplicate || unverified)) {
      // Incomplete assessments cannot produce a trustworthy human review queue.
      throw new Error(
        `Missing review classification or severity for finding ${index}.`,
      );
    }
    let status = "unverified";
    if (outsideHit) {
      status = "known-hit-outside-area";
    } else if (outsideInvalid) {
      status = "known-invalid-outside-area";
    } else if (outsideDuplicate) {
      status = "duplicate-outside-area";
    } else if (hit) {
      status = "known-hit";
    } else if (invalid) {
      status = "known-invalid";
    } else if (duplicate) {
      status = "duplicate";
    }
    const reason =
      outsideHit?.reason ??
      outsideInvalid?.reason ??
      outsideDuplicate?.reason ??
      hit?.reason ??
      invalid?.reason ??
      duplicate?.reason ??
      unverified?.reason ??
      "";
    let target: KnownBug | undefined;
    if (hit) target = groundTruth[hit.groundTruthIndex];
    let reference: Finding | undefined =
      outsideHit?.reference ?? outsideInvalid?.reference ?? target;
    if (!reference && invalid)
      reference = knownInvalid[invalid.knownInvalidIndex];
    const referenceLines: string[] = [];
    if (reference) referenceLines.push(`Reference: ${text(reference.name)}`);
    let severityLabel = `Estimated severity: **${severity.severity}**: ${text(severity.reason)} (not scored)`;
    let rowSeverity = `${severity.severity} (estimate, not scored)`;
    if (target) {
      severityLabel = `Severity: **${target.severity}** (stored reference weight)`;
      rowSeverity = String(target.severity);
    }
    if ((invalid || outsideInvalid) && reference) {
      // Preserve the human's rejection rationale separately from the model's matching explanation.
      for (const field of ["reason", "reviewedBy", "reviewedAt"]) {
        const value = reference[field];
        if (typeof value === "string")
          referenceLines.push(`${field}: ${text(value)}`);
      }
    }
    const canonicalDuplicate = duplicate ?? outsideDuplicate;
    if (canonicalDuplicate) {
      referenceLines.push(
        `Canonical finding: ${link(String(canonicalDuplicate.canonicalFindingIndex + 1), directory, path.join(directory, findingFile(canonicalDuplicate.canonicalFindingIndex)))}`,
      );
    }
    const file = path.join(directory, findingFile(index));
    await writeFile(
      file,
      [
        `# ${text(finding.name)}`,
        "",
        `Status: **${status}**`,
        "",
        severityLabel,
        "",
        `Assessment: ${text(reason)}`,
        "",
        ...referenceLines,
        "",
        ...findingDetails(finding),
        "## Saved evidence",
        "",
        ...(await evidenceLines(finding, reportDirectory)),
        "",
        reviewNote,
        "",
      ].join("\n"),
    );
    rows.push(
      `| ${index + 1} | ${status} | ${rowSeverity} | ${link(finding.name.replaceAll("\n", " "), reportDirectory, file)} |`,
    );
  }
  const outsideIndices = new Set([
    ...(outsideArea?.knownHits ?? []).map((finding) => finding.findingIndex),
    ...(outsideArea?.knownInvalid ?? []).map((finding) => finding.findingIndex),
    ...(outsideArea?.duplicates ?? []).map((finding) => finding.findingIndex),
  ]);
  const unverifiedCount = assessment.unverified.filter(
    (finding) => !outsideIndices.has(finding.findingIndex),
  ).length;
  await writeFile(
    path.join(reportDirectory, "review.md"),
    [
      "# Finding review",
      "",
      `${unverifiedCount} unverified findings need human validation. Every submitted finding, including flags, appears below.`,
      "",
      "Unmatched claims are not false positives. Known hits use stored reference severity; all other severity values are impact estimates for review and earn no points. Confirm the behavior and product expectation before updating fixture references.",
      "",
      "| Finding | Status | Severity | Reproduction and evidence |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      "After human verification, add a valid finding with required severity (1, 3, or 5) to the fixture's ground-truth.json or a disproved claim to known-invalid.json with a rejection reason. Regrade saved reports with --grade-only. Reference changes must be applied to all agents before comparison.",
      "",
    ].join("\n"),
  );
  return "review.md";
}

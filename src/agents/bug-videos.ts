import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
/** A pinned ffmpeg, so cutting doesn't depend on the machine's ffmpeg. */
const ffmpeg = z.string().parse(ffmpegPath);
/** Longest clip, and the shortest stretch since the previous bug worth showing alone. */
const MAX_CLIP_MS = 5 * 60_000;
const MIN_CLIP_MS = 10_000;
/** Time after the browser's last frame for the page to show its result. */
const SETTLE_MS = 15_000;
/** Mo's clip size limit. */
const MAX_CLIP_BYTES = 14 * 1024 * 1024;

/** One line of a run's browser log: a frame the recorder saved, and when it arrived. */
export const BrowserLogSchema = z
  .object({ at: z.iso.datetime(), frame: z.string() })
  .strict();

export type BugRecording = {
  /** The clip is artifacts/<artifactId>.mp4 in the report directory. */
  artifactId: string;
  startedAt: string;
  finishedAt: string;
};

type Bug = { id: string; submittedAt: string };
type Frame = { at: number; path: string };

export async function appendBrowserLog(
  file: string,
  entry: z.infer<typeof BrowserLogSchema>,
) {
  await appendFile(file, `${JSON.stringify(entry)}\n`);
}

async function readFrames(file: string): Promise<Frame[]> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT"))
      throw err;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => BrowserLogSchema.parse(JSON.parse(line)))
    .map((entry) => ({ at: Date.parse(entry.at), path: entry.frame }));
}

/**
 * Each bug's clip runs from the previous bug, or at most five minutes back, to
 * just after the browser last changed before the bug was saved.
 */
function planClips(bugs: Bug[], frames: Frame[]) {
  let previous: number | undefined;
  const clips: { bugId: string; startedAt: number; finishedAt: number }[] = [];
  for (const bug of [...bugs].sort((a, b) =>
    a.submittedAt.localeCompare(b.submittedAt),
  )) {
    const at = Date.parse(bug.submittedAt);
    const last = frames.findLast((frame) => frame.at <= at);
    if (!last) continue;
    const finishedAt = Math.min(at, last.at + SETTLE_MS);
    const startedAt = Math.max(
      frames[0].at,
      previous !== undefined && finishedAt - previous >= MIN_CLIP_MS
        ? previous
        : finishedAt - MAX_CLIP_MS,
    );
    previous = finishedAt;
    if (finishedAt - startedAt >= 100)
      clips.push({ bugId: bug.id, startedAt, finishedAt });
  }
  return clips;
}

/** Quotes a path for an ffconcat manifest. */
function quote(file: string) {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

/**
 * Mo's encoder (encodeVideoReviewFrames): holds each JPEG until the next one,
 * so still pages keep their real duration, then 1280x720 10 fps h264 within
 * Mo's size limit.
 */
async function encodeClip({
  frames,
  startedAt,
  finishedAt,
  videoPath,
  signal,
}: {
  frames: Frame[];
  startedAt: number;
  finishedAt: number;
  videoPath: string;
  signal: AbortSignal;
}) {
  // The frame before the window stays on screen until the first one inside it.
  const baseline = frames.findLastIndex((frame) => frame.at <= startedAt);
  const selected = frames
    .slice(Math.max(0, baseline))
    .filter((frame) => frame.at <= finishedAt);
  const lastFrame = selected.at(-1);
  if (!lastFrame) throw new Error("No frames in the clip");
  const durationMs = finishedAt - startedAt;
  const manifest = ["ffconcat version 1.0"];
  for (const [index, frame] of selected.entries()) {
    const at = Math.max(startedAt, frame.at);
    const nextAt = selected[index + 1]?.at ?? finishedAt;
    manifest.push(
      `file ${quote(frame.path)}`,
      `duration ${(nextAt - at) / 1000}`,
    );
  }
  // ffconcat repeats the last file so its duration is honored
  manifest.push(`file ${quote(lastFrame.path)}`);
  const manifestPath = `${videoPath}.txt`;
  const maxRateKbps = Math.min(
    1500,
    Math.floor((MAX_CLIP_BYTES * 8 * 0.9) / (durationMs / 1000 + 1) / 1000),
  );
  try {
    await writeFile(manifestPath, manifest.join("\n"), { signal });
    // -fs stops one byte past the limit, which the size check below rejects
    await exec(
      ffmpeg,
      [
        ...["-y", "-loglevel", "error", "-threads", "1"],
        ...["-filter_threads", "1"],
        ...["-f", "concat", "-safe", "0", "-i", manifestPath],
        ...["-t", String(durationMs / 1000)],
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=10",
        ...["-c:v", "libx264", "-threads", "1", "-preset", "ultrafast"],
        ...["-crf", "23", "-maxrate", `${maxRateKbps}k`],
        ...["-bufsize", `${maxRateKbps}k`, "-pix_fmt", "yuv420p"],
        ...["-movflags", "+faststart", "-an"],
        ...["-fs", String(MAX_CLIP_BYTES + 1)],
        videoPath,
      ],
      { signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await rm(manifestPath, { force: true });
  }
  if ((await stat(videoPath)).size > MAX_CLIP_BYTES)
    throw new Error("The clip is over Mo's size limit");
}

/** Cuts a clip for each bug from the run's browser frames into `<reportDirectory>/artifacts`. */
export async function cutBugVideos({
  browserLog,
  bugs,
  reportDirectory,
  signal,
}: {
  browserLog: string;
  bugs: Bug[];
  reportDirectory: string;
  signal: AbortSignal;
}) {
  const recordings = new Map<string, BugRecording>();
  const errors: string[] = [];
  const frames = await readFrames(browserLog);
  const artifacts = path.join(reportDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  for (const [index, clip] of planClips(bugs, frames).entries()) {
    const artifactId = `bug-${index + 1}-${clip.bugId.replace(/[^\w-]+/g, "-").slice(0, 80)}`;
    try {
      await encodeClip({
        frames,
        startedAt: clip.startedAt,
        finishedAt: clip.finishedAt,
        videoPath: path.join(artifacts, `${artifactId}.mp4`),
        signal,
      });
    } catch {
      await rm(path.join(artifacts, `${artifactId}.mp4`), { force: true });
      errors.push(`CLIP_FAILED:${clip.bugId}`);
      continue;
    }
    recordings.set(clip.bugId, {
      artifactId,
      startedAt: new Date(clip.startedAt).toISOString(),
      finishedAt: new Date(clip.finishedAt).toISOString(),
    });
  }
  for (const bug of bugs)
    if (!recordings.has(bug.id)) errors.push(`BUG_NOT_RECORDED:${bug.id}`);
  return { recordings, errors };
}

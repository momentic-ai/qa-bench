import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { BrowserRecorder } from "../../browser-tools/recording/browser-recorder";
import {
  appendBrowserLog,
  cutBugVideos,
} from "../../browser-tools/recording/bug-videos";
import { LenientReportSchema } from "../../evals/reports";
import { writeJson } from "../../shared/json-file";

type Report = z.infer<typeof LenientReportSchema>;

/**
 * Records a Browser Use browser, or takes Pi's own frames, and notes when each
 * bug first appears in the saved report, so each bug gets a clip like Codex's.
 * Bugs are matched by name and occurrence. A bug's time is when a poll, or the
 * final report if no poll saw it, first showed it.
 */
export class BrowserUseBugVideos {
  private readonly recorder: BrowserRecorder;
  private readonly browserLog: string;
  private readonly frames: string;
  /** For each bug name, when each of its occurrences first appeared. */
  private readonly firstSeen = new Map<string, string[]>();
  private readonly stopped = new AbortController();
  private polling: Promise<void> | undefined;

  constructor(
    runDirectory: string,
    private readonly reportDirectory: string,
  ) {
    this.browserLog = path.join(runDirectory, "browser-log.jsonl");
    this.frames = path.join(runDirectory, "browser-frames");
    this.recorder = new BrowserRecorder(this.browserLog, this.frames);
  }

  /** Records the browser over its own CDP connection. */
  record(cdpUrl: string) {
    this.recorder.record(cdpUrl);
  }

  /** Adds the frames Pi's recorder saved; a second CDP client gets no frames while Pi drives. */
  async addPiFrames(manifestPath: string) {
    const { frames } = z
      .object({
        frames: z.array(z.object({ file: z.string(), timestamp: z.number() })),
      })
      .parse(JSON.parse(await readFile(manifestPath, "utf8")));
    for (const frame of frames)
      await appendBrowserLog(this.browserLog, {
        at: new Date(frame.timestamp).toISOString(),
        frame: path.join(path.dirname(manifestPath), frame.file),
      });
  }

  poll(
    readReport: (signal: AbortSignal) => Promise<Report | undefined>,
    intervalMs: number,
  ) {
    const { signal } = this.stopped;
    this.polling = (async () => {
      while (!signal.aborted) {
        // A failed poll only makes the next bug's time later.
        this.note(await readReport(signal).catch(() => undefined));
        await delay(intervalMs, undefined, { signal }).catch(() => undefined);
      }
    })();
  }

  private note(report: Report | undefined) {
    const now = new Date().toISOString();
    const counts = new Map<string, number>();
    for (const bug of report?.bugs ?? []) {
      const count = (counts.get(bug.name) ?? 0) + 1;
      counts.set(bug.name, count);
      const seen = this.firstSeen.get(bug.name) ?? [];
      if (seen.length < count) seen.push(now);
      this.firstSeen.set(bug.name, seen);
    }
  }

  /** One stable ID and time per report entry, numbering repeated names. */
  private submissions(report: Report) {
    const counts = new Map<string, number>();
    return report.bugs.map((bug) => {
      const index = counts.get(bug.name) ?? 0;
      counts.set(bug.name, index + 1);
      return {
        id: index ? `${bug.name} (${index + 1})` : bug.name,
        submittedAt: this.firstSeen.get(bug.name)?.[index] ?? "",
      };
    });
  }

  /** Call before the browser stops, so the last frames are saved. */
  async stop() {
    this.stopped.abort();
    await this.polling;
    await this.recorder.stop();
  }

  /** Adds a clip to each bug it can; videos never decide a run's result. */
  async attach(report: Report, signal: AbortSignal) {
    this.note(report);
    const submissions = this.submissions(report);
    try {
      const { recordings, errors } = await cutBugVideos({
        browserLog: this.browserLog,
        bugs: submissions,
        reportDirectory: this.reportDirectory,
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      });
      if (errors.length) {
        process.stderr.write(`Bug videos incomplete: ${errors.join(", ")}\n`);
        await writeJson(
          path.join(this.reportDirectory, "recording-errors.json"),
          errors,
        );
      }
      return {
        ...report,
        bugs: report.bugs.map((bug, index) => {
          const recording = recordings.get(submissions[index].id);
          return recording ? { ...bug, recording } : bug;
        }),
      };
    } catch (err) {
      process.stderr.write(`Bug videos failed: ${String(err)}\n`);
      return report;
    } finally {
      // Leftover frames only cost disk space; they must not lose the report.
      await rm(this.frames, { recursive: true, force: true }).catch(() => {});
      await rm(this.browserLog, { force: true }).catch(() => {});
    }
  }
}

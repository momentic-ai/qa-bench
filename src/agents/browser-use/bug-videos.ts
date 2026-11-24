import { rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { LenientReportSchema } from "../../evals/reports";
import { writeJson } from "../../shared/json-file";
import { BrowserRecorder } from "../browser-recorder";
import { cutBugVideos } from "../bug-videos";

type Report = z.infer<typeof LenientReportSchema>;

/**
 * Records a Browser Use browser over its own CDP connection and notes when each
 * bug first appears in the saved report, so each bug gets a clip like Codex's.
 * Bugs are matched by name, and a bug's time is when a poll first saw it.
 */
export class BrowserUseBugVideos {
  private readonly recorder: BrowserRecorder;
  private readonly browserLog: string;
  private readonly frames: string;
  private readonly firstSeen = new Map<string, string>();
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

  start(
    cdpUrl: string,
    readReport: (signal: AbortSignal) => Promise<Report | undefined>,
    intervalMs: number,
  ) {
    this.recorder.record(cdpUrl);
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
    for (const bug of report?.bugs ?? [])
      if (!this.firstSeen.has(bug.name)) this.firstSeen.set(bug.name, now);
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
    try {
      const { recordings, errors } = await cutBugVideos({
        browserLog: this.browserLog,
        bugs: report.bugs.map((bug) => ({
          id: bug.name,
          submittedAt: this.firstSeen.get(bug.name) ?? new Date().toISOString(),
        })),
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
        bugs: report.bugs.map((bug) => {
          const recording = recordings.get(bug.name);
          return recording ? { ...bug, recording } : bug;
        }),
      };
    } catch (err) {
      process.stderr.write(`Bug videos failed: ${String(err)}\n`);
      return report;
    } finally {
      await rm(this.frames, { recursive: true, force: true });
      await rm(this.browserLog, { force: true });
    }
  }
}

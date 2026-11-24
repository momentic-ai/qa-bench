import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Browser, Page, chromium } from "playwright-core";

import { appendBrowserLog } from "./bug-videos";

// Same capture as Mo's original-video spool: the active tab's screencast at
// most 1280x720, one frame per 100 ms at most, each saved as a timestamped JPEG.
const FRAME_INTERVAL_MS = 100;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const SCREENCAST = { size: { width: 1280, height: 720 } };

/**
 * Saves a run's frames as JPEG files and lists each with its time in the
 * browser log. Like Mo's spool it keeps at most one frame per 100 ms.
 */
class FrameSpool {
  private next = 0;
  private lastFrameAt = -Infinity;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private directory: string,
    private log: string,
  ) {}

  onFrame(data: Buffer) {
    const at = Date.now();
    if (data.byteLength > MAX_FRAME_BYTES) return;
    if (at - this.lastFrameAt < FRAME_INTERVAL_MS) return;
    this.lastFrameAt = at;
    const frame = path.join(this.directory, `${this.next++}.jpg`);
    this.writing = this.writing
      .then(() => mkdir(this.directory, { recursive: true }))
      .then(() => writeFile(frame, data))
      .then(() =>
        appendBrowserLog(this.log, { at: new Date(at).toISOString(), frame }),
      )
      // Capture is best effort; a lost frame only lengthens its predecessor.
      .catch(() => undefined);
  }

  /** Waits for the frames still being saved. */
  async flush() {
    await this.writing;
  }
}

/**
 * Records one browser over its own connection. It only watches: it never
 * sends input to a page, so recording cannot change the agent's results.
 * Like Mo's session, it shows one tab: the newest that is still open.
 */
class RecordedBrowser {
  private browser: Promise<Browser | undefined>;
  private pages: Page[] = [];

  constructor(
    url: string,
    private spool: FrameSpool,
  ) {
    this.browser = chromium.connectOverCDP(url).then(
      (browser) => {
        for (const context of browser.contexts()) {
          context.pages().forEach((page) => this.record(page));
          context.on("page", (page) => this.record(page));
        }
        return browser;
      },
      (err) => {
        process.stderr.write(`Browser recording error: ${String(err)}\n`);
        return undefined;
      },
    );
  }

  private record(page: Page) {
    this.pages.push(page);
    page.once("close", () => {
      this.pages = this.pages.filter((open) => open !== page);
    });
    const options = {
      ...SCREENCAST,
      onFrame: ({ data }: { data: Buffer }) => {
        if (page === this.pages.at(-1)) this.spool.onFrame(data);
      },
    };
    let running = page.screencast.start(options);
    running.catch(() => {});
    // A screencast started before a page's first navigation can stop sending
    // frames once it commits, so each new document gets a fresh one.
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      running = running
        .then(() => page.screencast.stop())
        .catch(() => {})
        .then(() => page.screencast.start(options));
      running.catch(() => {});
    });
  }

  async stop() {
    const browser = await this.browser;
    await browser?.close().catch(() => {});
  }
}

/** Records every browser a run's broker hands out, for bug videos. */
export class BrowserRecorder {
  private browsers: RecordedBrowser[] = [];
  private spool: FrameSpool;

  constructor(log: string, frames: string) {
    this.spool = new FrameSpool(frames, log);
  }

  record(webSocketUrl: string) {
    this.browsers.push(new RecordedBrowser(webSocketUrl, this.spool));
  }

  /** Call before the browsers are released. */
  async stop() {
    await Promise.all(this.browsers.map((browser) => browser.stop()));
    await this.spool.flush();
  }
}

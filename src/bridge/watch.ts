// Watching a .cocaide.json file for new versions: the session's working file
// (written by the MCP server after every kept change) and a file the app
// follows in Live link mode. Polls the file's size and time (fs.watch misses
// atomic renames on some systems) and also checks at once when told a change
// happened; reports each new, complete JSON text once.

import { readFile, stat } from "node:fs/promises";

/** The largest document pushed to the app. */
export const MAX_DOC_BYTES = 50 * 2 ** 20;

export interface WatchOptions {
  intervalMs?: number;
  /** Wait this long after a hint before reading, so a burst of changes is one read. */
  debounceMs?: number;
  onChange(text: string): void;
  onError?(message: string): void;
}

export class DocWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private last = "";
  private sig = "";
  private reading: Promise<void> | null = null;
  private problem = "";

  constructor(
    readonly path: string,
    private readonly o: WatchOptions,
  ) {}

  /** Starts polling; `initial` is the text the other side already has (not reported again). */
  start(initial = "") {
    this.last = initial;
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? 250);
    return this;
  }

  /** A change probably happened: look soon. */
  hint() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.check(true);
    }, this.o.debounceMs ?? 60);
  }

  /** Reads the file if it changed (or `force`), and reports a new text. */
  check(force = false): Promise<void> {
    if (this.reading) return this.reading.then(() => (force ? this.check(true) : undefined));
    this.reading = this.read(force).finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(force: boolean) {
    try {
      const st = await stat(this.path);
      const sig = `${st.size}:${st.mtimeMs}`;
      if (!force && sig === this.sig) return;
      this.sig = sig;
      if (st.size > MAX_DOC_BYTES) return this.fail(`the file is ${(st.size / 2 ** 20).toFixed(0)} MB, more than the ${MAX_DOC_BYTES / 2 ** 20} MB the bridge sends`);
      const text = await readFile(this.path, "utf8");
      if (text === this.last) return;
      try {
        JSON.parse(text);
      } catch {
        return; // caught mid-write: the next look gets the whole file
      }
      this.last = text;
      this.problem = "";
      this.o.onChange(text);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.fail(err.code === "ENOENT" ? "the file does not exist (yet)" : err.message);
    }
  }

  private fail(message: string) {
    if (message === this.problem) return;
    this.problem = message;
    this.o.onError?.(message);
  }

  /** The last text reported (or given at start). */
  get text() {
    return this.last;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = this.pending = null;
  }
}

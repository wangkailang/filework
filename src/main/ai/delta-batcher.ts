/**
 * Delta Batcher — batches text-delta stream events into time windows
 *
 * Reduces IPC event frequency by collecting deltas within a configurable
 * window (default 30ms) and flushing as a single concatenated string.
 */

export class DeltaBatcher {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly flush: (text: string) => void;

  constructor(opts: { windowMs?: number; flush: (text: string) => void }) {
    this.windowMs = opts.windowMs ?? 30;
    this.flush = opts.flush;
  }

  /** Enqueue a text delta. It will be flushed after the current window expires. */
  push(text: string): void {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), this.windowMs);
    }
  }

  /** Force-flush any buffered text immediately (e.g. on stream end). */
  drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer) {
      this.doFlush();
    }
  }

  private doFlush(): void {
    this.timer = null;
    const text = this.buffer;
    this.buffer = "";
    if (text) {
      this.flush(text);
    }
  }
}

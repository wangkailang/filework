/**
 * Delta Batcher —— 将 text-delta 流事件按时间窗口批量合并
 *
 * 通过在可配置的窗口(默认 30ms)内收集增量,并以单个拼接后的字符串刷出,
 * 从而降低 IPC 事件频率。
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

  /** 入队一个文本增量。会在当前窗口到期后刷出。 */
  push(text: string): void {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), this.windowMs);
    }
  }

  /** 立即强制刷出所有缓冲文本(例如流结束时)。 */
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

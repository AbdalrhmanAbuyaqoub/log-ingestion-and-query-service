import { loadConfig } from '../config.js';
import { insertLogs } from './insert.js';
import { IngestionUnavailableError } from './errors.js';
import type { ValidLogEntry } from './types.js';

type PendingRequest = {
  entries: ValidLogEntry[];
  enqueuedAt: number;
  resolve: (accepted: number) => void;
  reject: (error: unknown) => void;
};

export type IngestionCoordinatorOptions = {
  flushIntervalMs: number;
  flushBatchSize: number;
  flushMaxEntries: number;
  bufferMax: number;
  insert?: (entries: ValidLogEntry[]) => Promise<number>;
  now?: () => number;
};

export class IngestionCoordinator {
  private readonly flushIntervalMs: number;
  private readonly flushBatchSize: number;
  private readonly flushMaxEntries: number;
  private readonly bufferMax: number;
  private readonly insert: (entries: ValidLogEntry[]) => Promise<number>;
  private readonly now: () => number;
  private queue: PendingRequest[] = [];
  private activeRequests: PendingRequest[] = [];
  private waitingEntries = 0;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopping = false;

  constructor(options: IngestionCoordinatorOptions) {
    this.flushIntervalMs = options.flushIntervalMs;
    this.flushBatchSize = options.flushBatchSize;
    this.flushMaxEntries = options.flushMaxEntries;
    this.bufferMax = options.bufferMax;
    this.insert = options.insert ?? insertLogs;
    this.now = options.now ?? Date.now;
  }

  enqueue(entries: ValidLogEntry[]): Promise<number> {
    if (this.stopping) {
      return Promise.reject(new IngestionUnavailableError('ingestion is shutting down'));
    }
    if (entries.length > this.bufferMax || this.waitingEntries + entries.length > this.bufferMax) {
      return Promise.reject(new IngestionUnavailableError('ingestion buffer full'));
    }

    return new Promise<number>((resolve, reject) => {
      this.queue.push({ entries, enqueuedAt: this.now(), resolve, reject });
      this.waitingEntries += entries.length;
      if (this.waitingEntries >= this.flushBatchSize) {
        this.clearTimer();
        void this.flush();
      } else {
        this.scheduleTimer();
      }
    });
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    const drain = this.drain();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drain,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('ingestion drain timed out')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.rejectOutstanding(error);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async drain(): Promise<void> {
    while (this.active || this.queue.length > 0) {
      if (this.active) await this.active;
      else await this.flush(true);
    }
  }

  private flush(force = false): Promise<void> {
    if (this.active) return this.active;
    if (this.queue.length === 0) return Promise.resolve();
    if (!force && this.waitingEntries < this.flushBatchSize) {
      this.scheduleTimer();
      return Promise.resolve();
    }

    this.clearTimer();
    const requests = this.takeNextFlush();
    this.activeRequests = requests;
    let entryCount = 0;
    for (const request of requests) entryCount += request.entries.length;
    const entries = new Array<ValidLogEntry>(entryCount);
    let entryIndex = 0;
    for (const request of requests) {
      for (const entry of request.entries) entries[entryIndex++] = entry;
    }

    this.active = this.insert(entries)
      .then((accepted) => {
        if (accepted !== entries.length) {
          throw new Error(`database accepted ${accepted} of ${entries.length} queued logs`);
        }
        for (const request of requests) request.resolve(request.entries.length);
      })
      .catch((error: unknown) => {
        for (const request of requests) request.reject(error);
      })
      .finally(() => {
        this.activeRequests = [];
        this.active = undefined;
        if (this.queue.length > 0) {
          if (this.stopping || this.waitingEntries >= this.flushBatchSize) void this.flush(true);
          else this.scheduleTimer();
        }
      });
    return this.active;
  }

  private takeNextFlush(): PendingRequest[] {
    let requestCount = 0;
    let entryCount = 0;
    while (requestCount < this.queue.length && entryCount < this.flushMaxEntries) {
      entryCount += this.queue[requestCount]!.entries.length;
      requestCount++;
    }
    const requests = this.queue.splice(0, requestCount);
    this.waitingEntries -= entryCount;
    return requests;
  }

  private scheduleTimer(): void {
    if (this.timer || this.queue.length === 0 || this.active) return;
    const oldest = this.queue[0]!;
    const delay = Math.max(0, oldest.enqueuedAt + this.flushIntervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(true);
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private rejectOutstanding(error: unknown): void {
    this.clearTimer();
    for (const request of [...this.queue, ...this.activeRequests]) request.reject(error);
    this.queue = [];
    this.activeRequests = [];
    this.waitingEntries = 0;
  }
}

let coordinator: IngestionCoordinator | undefined;

export function getIngestionCoordinator(): IngestionCoordinator {
  if (!coordinator) {
    const config = loadConfig();
    coordinator = new IngestionCoordinator({
      flushIntervalMs: config.INGEST_FLUSH_INTERVAL_MS,
      flushBatchSize: config.INGEST_FLUSH_BATCH_SIZE,
      flushMaxEntries: config.INGEST_FLUSH_MAX_ENTRIES,
      bufferMax: config.INGEST_BUFFER_MAX,
    });
  }
  return coordinator;
}

export async function stopIngestionCoordinator(timeoutMs = 5_000): Promise<void> {
  await coordinator?.stop(timeoutMs);
}

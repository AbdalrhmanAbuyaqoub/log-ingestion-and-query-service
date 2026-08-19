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
  private inFlight: PendingRequest[] = [];
  private waitingEntries = 0;
  private stopping = false;
  private wake: (() => void) | undefined;
  private readonly loopDone: Promise<void>;

  constructor(options: IngestionCoordinatorOptions) {
    this.flushIntervalMs = options.flushIntervalMs;
    this.flushBatchSize = options.flushBatchSize;
    this.flushMaxEntries = options.flushMaxEntries;
    this.bufferMax = options.bufferMax;
    this.insert = options.insert ?? insertLogs;
    this.now = options.now ?? Date.now;
    this.loopDone = this.run();
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
      this.notify();
    });
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true;
    this.notify();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.loopDone,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ingestion drain timed out')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.rejectOutstanding(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Single loop drives every flush. Nothing else ever calls insert(),
  // so there's no reentrancy guard to maintain by hand.
  private async run(): Promise<void> {
    while (!this.stopping || this.queue.length > 0) {
      if (this.queue.length === 0) {
        await this.sleep();
        continue;
      }
      if (!this.stopping && this.waitingEntries < this.flushBatchSize) {
        const oldest = this.queue[0]!;
        const delay = oldest.enqueuedAt + this.flushIntervalMs - this.now();
        if (delay > 0) {
          await this.sleep(delay);
          continue;
        }
      }
      await this.flushOnce();
    }
  }

  private sleep(ms?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      this.wake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      if (ms !== undefined) {
        timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, ms);
      }
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async flushOnce(): Promise<void> {
    const requests = this.takeNextFlush();
    this.inFlight = requests;
    const entries = requests.flatMap((request) => request.entries);
    try {
      const accepted = await this.insert(entries);
      if (accepted !== entries.length) {
        throw new Error(`database accepted ${accepted} of ${entries.length} queued logs`);
      }
      for (const request of requests) request.resolve(request.entries.length);
    } catch (error) {
      for (const request of requests) request.reject(error);
    } finally {
      this.inFlight = [];
    }
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

  private rejectOutstanding(error: unknown): void {
    for (const request of [...this.queue, ...this.inFlight]) request.reject(error);
    this.queue = [];
    this.inFlight = [];
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

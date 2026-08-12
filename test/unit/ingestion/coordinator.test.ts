import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ingestion/insert.js', () => ({ insertLogs: vi.fn() }));

import { IngestionCoordinator } from '../../../src/ingestion/coordinator.js';
import { IngestionUnavailableError } from '../../../src/ingestion/errors.js';
import type { ValidLogEntry } from '../../../src/ingestion/types.js';

function entry(index: number): ValidLogEntry {
  return {
    timestamp: new Date(`2026-08-13T10:00:${String(index % 60).padStart(2, '0')}Z`),
    level: 'info',
    service: 'api',
    message: `entry ${index}`,
    attributes: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('IngestionCoordinator', () => {
  it('coalesces whole requests when the entry threshold is reached', async () => {
    const insert = vi.fn(async (entries: ValidLogEntry[]) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 3,
      bufferMax: 10,
      insert,
    });

    const first = coordinator.enqueue([entry(1), entry(2)]);
    const second = coordinator.enqueue([entry(3), entry(4)]);

    await expect(Promise.all([first, second])).resolves.toEqual([2, 2]);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toHaveLength(4);
  });

  it('flushes a partial batch when its oldest request reaches the interval', async () => {
    vi.useFakeTimers();
    const insert = vi.fn(async (entries: ValidLogEntry[]) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 200,
      bufferMax: 10_000,
      insert,
      now: () => Date.now(),
    });

    const accepted = coordinator.enqueue([entry(1)]);
    await vi.advanceTimersByTimeAsync(49);
    expect(insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(accepted).resolves.toBe(1);
    expect(insert).toHaveBeenCalledOnce();
  });

  it('serializes flushes and sends arrivals during a write in the next batch', async () => {
    const firstInsert = deferred<number>();
    const insert = vi
      .fn<(entries: ValidLogEntry[]) => Promise<number>>()
      .mockReturnValueOnce(firstInsert.promise)
      .mockImplementationOnce(async (entries) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 2,
      bufferMax: 10,
      insert,
    });

    const first = coordinator.enqueue([entry(1), entry(2)]);
    const second = coordinator.enqueue([entry(3), entry(4)]);
    expect(insert).toHaveBeenCalledOnce();

    firstInsert.resolve(2);
    await expect(first).resolves.toBe(2);
    await expect(second).resolves.toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('rejects every request in a failed flush without retrying', async () => {
    const failure = new Error('database unavailable');
    const insert = vi.fn().mockRejectedValue(failure);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 2,
      bufferMax: 10,
      insert,
    });

    const first = coordinator.enqueue([entry(1)]);
    const second = coordinator.enqueue([entry(2)]);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(insert).toHaveBeenCalledOnce();
  });

  it('rejects an entire request when the waiting buffer is full', async () => {
    const insert = vi.fn(async (entries: ValidLogEntry[]) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 10,
      bufferMax: 2,
      insert,
    });

    const accepted = coordinator.enqueue([entry(1), entry(2)]);
    await expect(coordinator.enqueue([entry(3)])).rejects.toBeInstanceOf(IngestionUnavailableError);
    await coordinator.stop();
    await expect(accepted).resolves.toBe(2);
  });

  it('forces a partial batch to drain and rejects new work during shutdown', async () => {
    const insert = vi.fn(async (entries: ValidLogEntry[]) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 5_000,
      flushBatchSize: 200,
      bufferMax: 10_000,
      insert,
    });
    const pending = coordinator.enqueue([entry(1)]);

    await coordinator.stop();

    await expect(pending).resolves.toBe(1);
    await expect(coordinator.enqueue([entry(2)])).rejects.toBeInstanceOf(IngestionUnavailableError);
  });
});

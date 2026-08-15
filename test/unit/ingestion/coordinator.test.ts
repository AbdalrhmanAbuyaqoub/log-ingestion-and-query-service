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
      flushMaxEntries: 10,
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
      flushMaxEntries: 8_000,
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

  it('serializes flushes and snapshots every request queued during the active write', async () => {
    const firstInsert = deferred<number>();
    const insert = vi
      .fn<(entries: ValidLogEntry[]) => Promise<number>>()
      .mockReturnValueOnce(firstInsert.promise)
      .mockImplementation(async (entries) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 3,
      flushMaxEntries: 20,
      bufferMax: 20,
      insert,
    });

    const first = coordinator.enqueue([entry(1), entry(2), entry(3)]);
    const second = coordinator.enqueue([entry(4), entry(5)]);
    const third = coordinator.enqueue([entry(6), entry(7)]);
    const fourth = coordinator.enqueue([entry(8), entry(9), entry(10)]);
    expect(insert).toHaveBeenCalledOnce();

    firstInsert.resolve(3);
    await expect(first).resolves.toBe(3);
    await expect(Promise.all([second, third, fourth])).resolves.toEqual([2, 2, 3]);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1]?.[0].map((item) => item.message)).toEqual([
      'entry 4',
      'entry 5',
      'entry 6',
      'entry 7',
      'entry 8',
      'entry 9',
      'entry 10',
    ]);
  });

  it('isolates a failed flush from later queued work without retrying', async () => {
    const failure = new Error('database unavailable');
    const firstInsert = deferred<number>();
    const insert = vi
      .fn<(entries: ValidLogEntry[]) => Promise<number>>()
      .mockReturnValueOnce(firstInsert.promise)
      .mockImplementationOnce(async (entries) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 2,
      flushMaxEntries: 20,
      bufferMax: 20,
      insert,
    });

    const first = coordinator.enqueue([entry(1)]);
    const second = coordinator.enqueue([entry(2)]);
    const later = coordinator.enqueue([entry(3), entry(4)]);
    const firstRejected = expect(first).rejects.toBe(failure);
    const secondRejected = expect(second).rejects.toBe(failure);

    firstInsert.reject(failure);

    await Promise.all([firstRejected, secondRejected]);
    await expect(later).resolves.toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0]?.[0].map((item) => item.message)).toEqual(['entry 1', 'entry 2']);
    expect(insert.mock.calls[1]?.[0].map((item) => item.message)).toEqual(['entry 3', 'entry 4']);
  });

  it('rejects an entire request when the waiting buffer is full', async () => {
    const insert = vi.fn(async (entries: ValidLogEntry[]) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 10,
      flushMaxEntries: 10,
      bufferMax: 2,
      insert,
    });

    const accepted = coordinator.enqueue([entry(1), entry(2)]);
    await expect(coordinator.enqueue([entry(3)])).rejects.toBeInstanceOf(IngestionUnavailableError);
    await coordinator.stop();
    await expect(accepted).resolves.toBe(2);
  });

  it('drains the active flush and one whole queued snapshot during shutdown', async () => {
    const firstInsert = deferred<number>();
    const insert = vi
      .fn<(entries: ValidLogEntry[]) => Promise<number>>()
      .mockReturnValueOnce(firstInsert.promise)
      .mockImplementation(async (entries) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 5_000,
      flushBatchSize: 3,
      flushMaxEntries: 10_000,
      bufferMax: 10_000,
      insert,
    });
    const first = coordinator.enqueue([entry(1), entry(2), entry(3)]);
    const second = coordinator.enqueue([entry(4), entry(5)]);
    const third = coordinator.enqueue([entry(6), entry(7)]);
    const fourth = coordinator.enqueue([entry(8), entry(9)]);

    const stopped = coordinator.stop();
    await expect(coordinator.enqueue([entry(10)])).rejects.toBeInstanceOf(
      IngestionUnavailableError,
    );
    firstInsert.resolve(3);

    await expect(stopped).resolves.toBeUndefined();
    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([3, 2, 2, 2]);
    expect(insert.mock.calls.map(([entries]) => entries.map((item) => item.message))).toEqual([
      ['entry 1', 'entry 2', 'entry 3'],
      ['entry 4', 'entry 5', 'entry 6', 'entry 7', 'entry 8', 'entry 9'],
    ]);
  });

  it('bounds FIFO flushes without splitting requests', async () => {
    const firstInsert = deferred<number>();
    const insert = vi
      .fn<(entries: ValidLogEntry[]) => Promise<number>>()
      .mockReturnValueOnce(firstInsert.promise)
      .mockImplementation(async (entries) => entries.length);
    const coordinator = new IngestionCoordinator({
      flushIntervalMs: 50,
      flushBatchSize: 2,
      flushMaxEntries: 5,
      bufferMax: 30,
      insert,
    });

    const active = coordinator.enqueue([entry(1), entry(2)]);
    const firstQueued = coordinator.enqueue([entry(3), entry(4), entry(5)]);
    const secondQueued = coordinator.enqueue([entry(6), entry(7), entry(8)]);
    const thirdQueued = coordinator.enqueue([entry(9), entry(10), entry(11)]);
    firstInsert.resolve(2);

    await expect(Promise.all([active, firstQueued, secondQueued, thirdQueued])).resolves.toEqual([
      2, 3, 3, 3,
    ]);
    expect(insert.mock.calls.map(([entries]) => entries.map((item) => item.message))).toEqual([
      ['entry 1', 'entry 2'],
      ['entry 3', 'entry 4', 'entry 5', 'entry 6', 'entry 7', 'entry 8'],
      ['entry 9', 'entry 10', 'entry 11'],
    ]);
  });
});

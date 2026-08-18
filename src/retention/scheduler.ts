import { dropExpiredPartitions } from './partition-manager.js';

const HOUR_MS = 60 * 60_000;

export type PartitionScheduler = {
  stop: () => Promise<void>;
};

export function startPartitionScheduler(retentionDays: number): PartitionScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let active: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (!stopped) timer = setTimeout(run, HOUR_MS);
  };

  const run = (): void => {
    active = dropExpiredPartitions(retentionDays)
      .then((result) => console.log('partition maintenance completed', result))
      .catch((error: unknown) => console.error('partition maintenance failed', error))
      .finally(schedule);
  };

  schedule();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}

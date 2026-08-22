import { dropExpiredPartitions, RetentionInvariantError } from './partition-manager.js';

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
      .catch((error: unknown) => {
        if (error instanceof RetentionInvariantError) {
          console.error('retention maintenance aborted', {
            code: error.code,
            retained_rows: error.retainedRows,
            earliest_retained: error.earliestRetained?.toISOString() ?? null,
            latest_retained: error.latestRetained?.toISOString() ?? null,
            cutoff: error.cutoff.toISOString(),
            action: 'maintenance_aborted',
            remediation: 'Investigate why retained timestamps were routed to logs_default',
            error,
          });
          return;
        }
        console.error('partition maintenance failed', error);
      })
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

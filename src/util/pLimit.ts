export type Release = () => void;

export interface Limit {
  readonly max: number;
  active(): number;
  pending(): number;
  acquire(): Promise<Release>;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function pLimit(max: number): Limit {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`pLimit: max must be >= 1, got ${max}`);
  }

  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (activeCount >= max) return;
    const fn = queue.shift();
    if (!fn) return;
    activeCount++;
    fn();
  };

  const acquire = (): Promise<Release> =>
    new Promise<Release>((resolve) => {
      const release: Release = () => {
        activeCount--;
        next();
      };
      queue.push(() => resolve(release));
      next();
    });

  return {
    get max() {
      return max;
    },
    active: () => activeCount,
    pending: () => queue.length,
    acquire,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

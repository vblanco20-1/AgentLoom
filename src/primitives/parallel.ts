// `parallel(thunks)` — Promise.all(thunks.map(t => t())). Thunk-not-promise
// is the universal Bun-corpus convention; it lets the runtime control *when*
// each task starts (the agent() concurrency cap kicks in here).

export type Thunk = () => unknown | Promise<unknown>;

export async function parallelImpl(thunks: Thunk[]): Promise<unknown[]> {
  return Promise.all(thunks.map((t) => Promise.resolve().then(t)));
}

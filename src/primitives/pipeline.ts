// Per-item streaming pipeline. Stage `n` is `(prev, originalItem, idx) => next`.
// Each item progresses through stages independently — item N can be in stage 2
// while item M is still in stage 1. No barrier between stages. Concurrency
// across items is bounded by the global `agentPool` in `agent()`.

export type PipelineStage = (
  prev: unknown,
  originalItem: unknown,
  idx: number,
) => unknown | Promise<unknown>;

export async function pipelineImpl(
  items: unknown[],
  ...stages: PipelineStage[]
): Promise<unknown[]> {
  return Promise.all(
    items.map((item, idx) =>
      stages.reduce<Promise<unknown>>(
        (prev, stage) => prev.then((v) => stage(v, item, idx)),
        Promise.resolve(item),
      ),
    ),
  );
}

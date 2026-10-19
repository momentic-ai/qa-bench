export async function runWorkers<Item>({
  items,
  concurrency,
  signal,
  run,
}: {
  items: readonly Item[];
  concurrency: number;
  signal: AbortSignal;
  run(item: Item, index: number): Promise<void>;
}): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length && !signal.aborted) {
      const index = next++;
      await run(items[index], index);
    }
  }

  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  const failures = results.flatMap((result) => {
    if (result.status === "rejected") {
      return [result.reason];
    }
    return [];
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Eval workers failed");
  }
}

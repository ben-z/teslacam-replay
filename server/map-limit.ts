/** Stop scheduling on failure, then drain running work before reporting it. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid worker concurrency: ${concurrency}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

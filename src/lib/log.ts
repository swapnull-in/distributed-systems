/** Timestamped logging so you can watch the distributed system work. */
export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}

/** Deterministic "sleep" for simulated time — resolves on the next microtask. */
export const tick = () => new Promise<void>((r) => setImmediate(r));

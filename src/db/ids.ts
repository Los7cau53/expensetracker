/**
 * Globally unique record ids.
 *
 * The app previously used Dexie's `++id` auto-increment, which is a counter
 * private to one device's database. That is fine for a single device and fatal
 * for sync: a phone and a laptop each minting payee `5` for different people
 * makes every `payeeId: 5` ambiguous, and no later merge can untangle it.
 */
export function newId(): string {
  // Available in every browser this app targets, and in Node 19+ for tests.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // Last resort: still collision-safe enough for one user's devices.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export type Id = string

/**
 * Sorts records into a stable, meaningful order.
 *
 * With auto-increment ids, `toArray()` happened to return insertion order and
 * plenty of code leaned on `[0]` being "the first one". UUID keys are random,
 * so that order is now arbitrary — every list that a reader sees, or that a
 * default is taken from, has to say what order it wants.
 */
export function byCreated<T extends { createdAt?: number; name?: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''),
  )
}

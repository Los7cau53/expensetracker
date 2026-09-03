// The test timezone is pinned in vitest.config.ts (`test.env.TZ`). Receipt
// timestamps are epoch seconds rendered in the device's local zone — correct
// for a phone in India, but it makes any assertion on a wall-clock time depend
// on where the test runs, and CI runs in UTC.

// Dexie needs an IndexedDB implementation; Node has none.
import 'fake-indexeddb/auto'

// jsdom has no ResizeObserver, which the responsive SVG charts use to size
// themselves. A stub that never fires leaves charts at width 0 — enough to
// assert they mount and that the table view carries the values.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// Neither Node nor this jsdom setup reliably provides localStorage, and the app
// uses it for UI preferences. An in-memory stand-in keeps tests honest without
// each one having to guard against its absence.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

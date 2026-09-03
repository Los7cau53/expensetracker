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

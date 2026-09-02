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

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import { deleteCategory, deleteSource, mergePayees, updateCategory } from '../db/manage'
import { sum } from '../db/queries'
import { applyRemote, pendingChanges, resetSyncCursors, syncCursors, syncOnce } from './engine'
import type { RemoteRecord, RemoteStore } from './types'

/** An in-memory stand-in for Firestore, so the merge rules can be tested. */
class FakeRemote implements RemoteStore {
  rows = new Map<string, RemoteRecord>()
  pushes = 0

  async pull(since: number) {
    return [...this.rows.values()]
      .filter((r) => r.updatedAt > since)
      .sort((a, b) => a.updatedAt - b.updatedAt)
  }

  async push(records: RemoteRecord[]) {
    this.pushes++
    for (const r of records) {
      const key = `${r.table}:${r.id}`
      const existing = this.rows.get(key)
      // The remote keeps the newest write, as Firestore rules will.
      if (!existing || r.updatedAt >= existing.updatedAt) this.rows.set(key, r)
    }
  }

  seed(r: RemoteRecord) {
    this.rows.set(`${r.table}:${r.id}`, r)
  }
}

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(),
    db.tombstones.clear(), db.settings.clear(),
  ])
  await seedIfEmpty()
  await resetSyncCursors()
}

async function addPayment(amount: number, date = '2026-02-01') {
  const projectId = (await db.projects.toArray())[0].id
  const sourceId = (await db.sources.toArray())[0].id
  const categoryId = (await db.categories.toArray())[0].id
  return (await db.txns.add({
    date, amount, projectId, sourceId, categoryId, voided: 0,
  } as never)) as string
}

beforeEach(reset)

describe('change stamps', () => {
  it('stamps every insert, so nothing is invisible to sync', async () => {
    const id = await addPayment(1_000_00)
    const row = (await db.txns.get(id))!
    expect(typeof row.updatedAt).toBe('number')
    expect(row.updatedAt).toBeGreaterThan(0)
  })

  it('moves the stamp on every update, however the record is changed', async () => {
    const id = await addPayment(1_000_00)
    const before = (await db.txns.get(id))!.updatedAt
    await new Promise((r) => setTimeout(r, 5))

    await db.txns.update(id, { note: 'edited' })

    expect((await db.txns.get(id))!.updatedAt).toBeGreaterThan(before)
  })
})

describe('pushing local work', () => {
  it('sends records changed since the cursor, oldest first', async () => {
    await addPayment(1_000_00)
    const changes = await pendingChanges(0)

    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.table === 'txns')).toBe(true)
    const stamps = changes.map((c) => c.updatedAt)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  })

  it('sends nothing when nothing has changed', async () => {
    const remote = new FakeRemote()
    await addPayment(1_000_00)
    await syncOnce(remote)

    const second = await syncOnce(remote)

    expect(second.pushed).toBe(0)
    expect(second.applied).toBe(0)
  })

  it('carries a deletion as a tombstone', async () => {
    const spare = (await db.sources.add({
      name: 'Spare', type: 'cash', openingBalance: 0, archived: 0,
    } as never)) as string
    const remote = new FakeRemote()
    await syncOnce(remote)

    await deleteSource(spare)
    const result = await syncOnce(remote)

    const sent = [...remote.rows.values()].find((r) => r.id === spare)
    expect(result.pushed).toBeGreaterThan(0)
    expect(sent?.deleted).toBe(true)
  })
})

describe('applying remote work', () => {
  it('inserts a record this device has never seen', async () => {
    const remote = new FakeRemote()
    remote.seed({
      table: 'payees',
      id: 'remote-payee',
      updatedAt: Date.now(),
      data: { id: 'remote-payee', name: 'Suresh electrical', role: 'electrician', archived: 0, createdAt: 1 },
    })

    const r = await syncOnce(remote)

    expect(r.applied).toBe(1)
    expect((await db.payees.get('remote-payee'))?.name).toBe('Suresh electrical')
  })

  it('lets the newer write win, whichever side it came from', async () => {
    const id = await addPayment(1_000_00)
    const local = (await db.txns.get(id))!

    // Remote edited the same payment later.
    const r1 = await applyRemote([
      { table: 'txns', id, updatedAt: local.updatedAt! + 1000, data: { ...local, amount: 2_000_00 } },
    ])
    expect(r1.applied).toBe(1)
    expect((await db.txns.get(id))!.amount).toBe(2_000_00)

    // An older remote copy must not undo it.
    const r2 = await applyRemote([
      { table: 'txns', id, updatedAt: local.updatedAt! - 1000, data: { ...local, amount: 9_999_00 } },
    ])
    expect(r2.skippedStale).toBe(1)
    expect((await db.txns.get(id))!.amount).toBe(2_000_00)
  })

  it('writes the remote stamp verbatim, so records do not ping-pong', async () => {
    const remote = new FakeRemote()
    const stamp = Date.now() - 60_000
    remote.seed({
      table: 'payees',
      id: 'p1',
      updatedAt: stamp,
      data: { id: 'p1', name: 'A', role: 'other', archived: 0, createdAt: 1 },
    })

    await syncOnce(remote)
    // Restamping with the local clock would make it look newer than the remote
    // and send it straight back, forever.
    expect((await db.payees.get('p1'))!.updatedAt).toBe(stamp)

    const second = await syncOnce(remote)
    expect(second.pushed).toBe(0)
  })

  it('applies a remote deletion', async () => {
    const remote = new FakeRemote()
    const id = await addPayment(1_000_00)
    await syncOnce(remote)

    const r = await applyRemote([{ table: 'txns', id, updatedAt: Date.now() + 1000, deleted: true }])

    expect(r.deletedLocally).toBe(1)
    expect(await db.txns.get(id)).toBeUndefined()
  })

  it('keeps a record edited after the delete reached it', async () => {
    const id = await addPayment(1_000_00)
    await db.txns.update(id, { note: 'edited here, later' })
    const local = (await db.txns.get(id))!

    // Someone deleted it before this edit happened.
    const r = await applyRemote([
      { table: 'txns', id, updatedAt: local.updatedAt! - 5_000, deleted: true },
    ])

    expect(r.skippedStale).toBe(1)
    expect(await db.txns.get(id)).toBeDefined()
  })

  it('ignores a table it does not know about', async () => {
    const r = await applyRemote([
      { table: 'settings' as never, id: 'x', updatedAt: Date.now(), data: { id: 'x' } },
    ])
    expect(r.applied).toBe(0)
  })
})

describe('two devices', () => {
  /**
   * The scenario the whole design exists for: both devices record different
   * payments while apart, then meet. Neither may lose work.
   */
  it('converges without losing either side', async () => {
    const remote = new FakeRemote()

    // Phone records two payments and syncs.
    const a = await addPayment(50_000_00, '2026-02-01')
    const b = await addPayment(30_000_00, '2026-02-02')
    await syncOnce(remote)
    const phoneTotal = sum((await db.txns.toArray()).map((t) => t.amount))

    // Laptop: a separate device, so a fresh local database sharing the remote.
    await reset()
    await syncOnce(remote)
    expect(await db.txns.count()).toBe(2)

    const c = await addPayment(20_000_00, '2026-03-01')
    await syncOnce(remote)

    // Phone comes back.
    await reset()
    const final = await syncOnce(remote)

    const ids = (await db.txns.toArray()).map((t) => t.id).sort()
    expect(ids).toEqual([a, b, c].sort())
    expect(sum((await db.txns.toArray()).map((t) => t.amount))).toBe(phoneTotal + 20_000_00)
    // Pulling back records this device just pushed is a harmless no-op, and
    // real Firestore does the same, so `skippedStale` is not asserted at zero.
    expect(final.deletedLocally).toBe(0)
  })

  it('propagates a merge done on one device', async () => {
    const remote = new FakeRemote()
    const keep = (await db.payees.add({ name: 'Ramesh mestri', role: 'mestri', archived: 0 } as never)) as string
    const dupe = (await db.payees.add({ name: 'ramesh Mestri', role: 'other', archived: 0 } as never)) as string
    const id = await addPayment(10_000_00)
    await db.txns.update(id, { payeeId: dupe })
    await syncOnce(remote)

    await mergePayees(dupe, keep)
    await syncOnce(remote)

    // The other device picks up both the reassignment and the deletion.
    await reset()
    await syncOnce(remote)

    expect(await db.payees.get(dupe)).toBeUndefined()
    expect((await db.txns.get(id))?.payeeId).toBe(keep)
  })

  it('is idempotent — syncing repeatedly changes nothing', async () => {
    const remote = new FakeRemote()
    await addPayment(1_000_00)
    await syncOnce(remote)
    const snapshot = JSON.stringify((await db.txns.toArray()).sort((x, y) => x.id.localeCompare(y.id)))

    for (let i = 0; i < 3; i++) {
      const r = await syncOnce(remote)
      expect(r.pushed).toBe(0)
      expect(r.applied).toBe(0)
    }

    expect(JSON.stringify((await db.txns.toArray()).sort((x, y) => x.id.localeCompare(y.id)))).toBe(snapshot)
  })

  it('advances its cursors only as far as the records it handled', async () => {
    const remote = new FakeRemote()
    await addPayment(1_000_00)
    await syncOnce(remote)

    const { pushedThrough } = await syncCursors()
    const highest = Math.max(...(await db.txns.toArray()).map((t) => t.updatedAt ?? 0))
    // Using "now" would step over a record written while the pass ran.
    expect(pushedThrough).toBeGreaterThanOrEqual(highest)
    expect(pushedThrough).toBeLessThanOrEqual(Date.now())
  })
})


describe('seeded defaults across devices', () => {
  it('does not multiply the default cost heads', async () => {
    const remote = new FakeRemote()
    const seeded = await db.categories.count()

    // Device one seeds and syncs.
    await syncOnce(remote)
    // Device two: a fresh database that seeds itself, then syncs.
    await reset()
    await syncOnce(remote)

    // Derived ids mean both devices created the same rows, so they collapse
    // rather than doubling to 48.
    expect(await db.categories.count()).toBe(seeded)
    const names = (await db.categories.toArray()).map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('does not multiply the default source or property either', async () => {
    const remote = new FakeRemote()
    await syncOnce(remote)
    await reset()
    await syncOnce(remote)

    expect(await db.sources.count()).toBe(1)
    expect(await db.projects.count()).toBe(1)
  })

  /**
   * The failure this guards: every device seeds the *same* derived ids, so a
   * device set up later holds a freshly stamped "Painting" that is newer than
   * the remote's deletion of it. It used to win — reinstating the cost heads
   * the user had deleted, reverting the ones they had renamed, and pushing
   * that back over the work on the device where they did it.
   */
  it('keeps a rename and a deletion made before this device existed', async () => {
    const remote = new FakeRemote()
    const cats = await db.categories.toArray()
    const renamed = cats.find((c) => c.name === 'Masonry')!
    const removed = cats.find((c) => c.name === 'Painting')!

    await updateCategory(renamed.id, 'Brick work')
    await deleteCategory(removed.id)
    await syncOnce(remote)

    // A second device: seeds the whole default list, then meets the remote.
    await reset()
    await syncOnce(remote)

    expect((await db.categories.get(renamed.id))?.name).toBe('Brick work')
    expect(await db.categories.get(removed.id)).toBeUndefined()
    // And it must not have pushed its own defaults over either change, which
    // is how the first device got them back.
    expect(remote.rows.get(`categories:${removed.id}`)?.deleted).toBe(true)
    expect(remote.rows.get(`categories:${renamed.id}`)?.data?.name).toBe('Brick work')
  })

  it('lets the remote win over defaults seeded by an older build', async () => {
    const remote = new FakeRemote()
    const cats = await db.categories.toArray()
    const renamed = cats.find((c) => c.name === 'Masonry')!
    const removed = cats.find((c) => c.name === 'Painting')!
    await updateCategory(renamed.id, 'Brick work')
    await deleteCategory(removed.id)
    await syncOnce(remote)

    // An already-installed device, whose defaults carry the wall-clock of its
    // own first run — what every install before SEED_STAMP looks like.
    await reset()
    const firstRun = Date.now() + 60_000
    for (const c of await db.categories.toArray()) {
      await db.categories.update(c.id, { updatedAt: firstRun })
    }
    await seedIfEmpty()
    await syncOnce(remote)

    expect((await db.categories.get(renamed.id))?.name).toBe('Brick work')
    expect(await db.categories.get(removed.id)).toBeUndefined()
  })

  it('leaves a default alone once the user has edited it', async () => {
    const renamed = (await db.categories.toArray()).find((c) => c.name === 'Masonry')!
    await updateCategory(renamed.id, 'Brick work')

    // Re-running startup must not demote a rename to a placeholder, or the
    // device would stop sending it.
    await seedIfEmpty()

    const changes = await pendingChanges(0)
    expect(changes.some((c) => c.table === 'categories' && c.id === renamed.id)).toBe(true)
  })

  it('still puts the untouched defaults on the remote', async () => {
    const remote = new FakeRemote()
    // Held back from a normal push, they would otherwise exist nowhere but on
    // the devices that happen to seed the same list, and a payment filed under
    // one of them would have nothing to resolve against.
    await syncOnce(remote)

    const local = (await db.categories.toArray()).map((c) => c.name).sort()
    const onRemote = [...remote.rows.values()]
      .filter((r) => r.table === 'categories' && !r.deleted)
      .map((r) => r.data!.name as string)
      .sort()
    expect(onRemote).toEqual(local)
  })
})

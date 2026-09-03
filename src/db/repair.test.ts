import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { seedIfEmpty } from './seed'
import { sum } from './queries'
import { findDuplicates, hardReset, mergeDuplicates } from './repair'

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(),
    db.tombstones.clear(), db.settings.clear(),
  ])
  await seedIfEmpty()
}

beforeEach(reset)

/**
 * Recreates what sync produced: the same 24 default cost heads a second time,
 * under random ids, because the migration and the seed disagreed about what id
 * a default should have.
 */
async function duplicateTheDefaults() {
  const originals = await db.categories.toArray()
  await db.categories.bulkAdd(
    originals.map((c) => ({ name: c.name, sortOrder: c.sortOrder, archived: 0 })) as never,
  )
  return originals.length
}

describe('finding duplicates', () => {
  it('spots the doubled defaults and picks the derived id to keep', async () => {
    const n = await duplicateTheDefaults()
    expect(await db.categories.count()).toBe(n * 2)

    const report = await findDuplicates()

    expect(report.groups.length).toBe(n)
    expect(report.totalExtra).toBe(n)
    // Both devices must fold the same direction, so the derived id wins.
    for (const g of report.groups) {
      expect(g.keepId.startsWith('seed-')).toBe(true)
      expect(g.mergeIds).toHaveLength(1)
    }
  })

  it('matches on name regardless of case and spacing', async () => {
    await db.payees.bulkAdd([
      { name: 'Ramesh mestri', role: 'mestri', archived: 0 },
      { name: '  ramesh   Mestri ', role: 'other', archived: 0 },
    ] as never)

    const report = await findDuplicates()
    const group = report.groups.find((g) => g.table === 'payees')
    expect(group?.mergeIds).toHaveLength(1)
  })

  it('reports nothing on a clean database', async () => {
    expect((await findDuplicates()).totalExtra).toBe(0)
  })

  it('leaves genuinely different names alone', async () => {
    await db.sources.bulkAdd([
      { name: 'ICICI 0763', type: 'bank', openingBalance: 0, archived: 0 },
      { name: 'ICICI 4471', type: 'bank', openingBalance: 0, archived: 0 },
    ] as never)
    expect((await findDuplicates()).groups.some((g) => g.table === 'sources')).toBe(false)
  })
})

describe('merging duplicates', () => {
  it('folds the doubled defaults back to one set', async () => {
    const n = await duplicateTheDefaults()

    const result = await mergeDuplicates()

    expect(result.merged).toBe(n)
    expect(await db.categories.count()).toBe(n)
    const names = (await db.categories.toArray()).map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('moves entries off the duplicate before deleting it, losing nothing', async () => {
    const projectId = (await db.projects.toArray())[0].id
    const sourceId = (await db.sources.toArray())[0].id
    const keep = (await db.categories.toArray())[0]
    const dupe = (await db.categories.add({
      name: keep.name, sortOrder: 99, archived: 0,
    } as never)) as string

    await db.txns.add({
      date: '2026-02-01', amount: 12_000_00, projectId, sourceId, categoryId: dupe, voided: 0,
    } as never)
    const before = sum((await db.txns.toArray()).map((t) => t.amount))

    const result = await mergeDuplicates()

    expect(result.movedEntries).toBeGreaterThan(0)
    expect(await db.categories.get(dupe)).toBeUndefined()
    expect((await db.txns.toArray())[0].categoryId).toBe(keep.id)
    expect(sum((await db.txns.toArray()).map((t) => t.amount))).toBe(before)
  })

  it('leaves tombstones so the other device drops the duplicate too', async () => {
    await duplicateTheDefaults()
    await mergeDuplicates()
    expect(await db.tombstones.count()).toBeGreaterThan(0)
  })

  it('is idempotent — a second pass finds nothing', async () => {
    await duplicateTheDefaults()
    await mergeDuplicates()
    expect((await mergeDuplicates()).merged).toBe(0)
  })
})

describe('hard reset', () => {
  async function withData() {
    const projectId = (await db.projects.toArray())[0].id
    const sourceId = (await db.sources.toArray())[0].id
    const categoryId = (await db.categories.toArray())[0].id
    await db.txns.add({
      date: '2026-02-01', amount: 5_000_00, projectId, sourceId, categoryId, voided: 0,
    } as never)
    await db.fundIns.add({ date: '2026-01-01', sourceId, amount: 1_000_00, origin: 'x' } as never)
    await db.settings.put({ key: 'lastBackupAt', value: 123 })
  }

  it('clears every local record', async () => {
    await withData()
    const result = await hardReset({})

    expect(result.localCleared).toBeGreaterThan(0)
    expect(await db.txns.count()).toBe(0)
    expect(await db.fundIns.count()).toBe(0)
    expect(await db.categories.count()).toBe(0)
    expect(await db.sources.count()).toBe(0)
    expect(await db.projects.count()).toBe(0)
  })

  it('leaves no tombstones behind', async () => {
    await withData()
    // Keeping them would push deletions at a device that may hold the only
    // remaining copy of the data.
    await hardReset({})
    expect(await db.tombstones.count()).toBe(0)
  })

  it('clears sync cursors and the migration marker', async () => {
    await withData()
    await db.settings.bulkPut([
      { key: 'syncPushedThrough', value: 999 },
      { key: 'legacyMigratedAt', value: 555 },
    ])

    await hardReset({})

    expect(await db.settings.get('syncPushedThrough')).toBeUndefined()
    expect(await db.settings.get('legacyMigratedAt')).toBeUndefined()
  })

  it('wipes the remote copy when asked, before touching anything local', async () => {
    await withData()
    const order: string[] = []
    const wipe = async () => {
      order.push('remote')
      return 7
    }

    const result = await hardReset({ includeRemote: true }, wipe)

    expect(result.remoteDeleted).toBe(7)
    expect(order).toEqual(['remote'])
    expect(await db.txns.count()).toBe(0)
  })

  it('keeps local data if wiping the remote fails', async () => {
    await withData()
    const failing = async () => {
      throw new Error('network gone')
    }

    await expect(hardReset({ includeRemote: true }, failing)).rejects.toThrow('network gone')
    // Nothing local was lost, so the reset can simply be retried.
    expect(await db.txns.count()).toBe(1)
  })

  it('does not touch the remote unless asked', async () => {
    await withData()
    let called = false
    await hardReset({}, async () => {
      called = true
      return 0
    })
    expect(called).toBe(false)
  })
})

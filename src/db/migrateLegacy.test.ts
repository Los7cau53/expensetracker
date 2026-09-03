import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, LEGACY_DB_NAME } from './schema'
import { legacyDatabaseExists, migrateLegacyIfNeeded } from './migrateLegacy'
import { sourceBalances, sum } from './queries'

/**
 * Builds a database in the old shape — numeric auto-increment ids, no
 * `archived` on categories — the way a device that has been in use would
 * actually have it.
 */
async function buildLegacy() {
  const legacy = new Dexie(LEGACY_DB_NAME)
  legacy.version(2).stores({
    projects: '++id, name, status',
    sources: '++id, name, type, archived',
    payees: '++id, name, role, archived',
    categories: '++id, name, sortOrder',
    txns: '++id, date, projectId, sourceId, payeeId, categoryId, voided, importBatchId',
    fundIns: '++id, date, sourceId, projectId, importBatchId',
    importBatches: '++id, importedAt',
    settings: 'key',
  })
  await legacy.open()

  const plotA = (await legacy.table('projects').add({ name: 'Plot 42', status: 'active', createdAt: 1 })) as number
  const plotB = (await legacy.table('projects').add({ name: 'Plot 7', status: 'active', createdAt: 2 })) as number
  const bank = (await legacy.table('sources').add({ name: 'ICICI 0763', type: 'bank', openingBalance: 10_000_00, archived: 0, createdAt: 1 })) as number
  const cash = (await legacy.table('sources').add({ name: 'Cash in hand', type: 'cash', openingBalance: 0, archived: 1, createdAt: 2 })) as number
  const mestri = (await legacy.table('payees').add({ name: 'Ramesh mestri', role: 'mestri', archived: 0, createdAt: 1 })) as number
  const masonry = (await legacy.table('categories').add({ name: 'Masonry', sortOrder: 5 })) as number
  const permits = (await legacy.table('categories').add({ name: 'Permits', sortOrder: 1 })) as number
  const batch = (await legacy.table('importBatches').add({ fileName: 'x.xlsx', sheetName: 'S', importedAt: 9, rowCount: 2, mapping: '{}' })) as number

  await legacy.table('txns').bulkAdd([
    { date: '2026-02-01', amount: 50_000_00, projectId: plotA, sourceId: bank, payeeId: mestri, categoryId: masonry, voided: 0, createdAt: 1, updatedAt: 1 },
    { date: '2026-02-10', amount: 8_500_00, projectId: plotA, sourceId: cash, categoryId: permits, voided: 0, importBatchId: batch, createdAt: 1, updatedAt: 1 },
    { date: '2026-03-01', amount: 20_000_00, projectId: plotB, sourceId: bank, payeeId: mestri, categoryId: masonry, voided: 0, createdAt: 1, updatedAt: 1 },
    // A reversal and a voided row: both must survive as they are.
    { date: '2026-03-05', amount: -5_000_00, projectId: plotA, sourceId: bank, categoryId: masonry, voided: 0, createdAt: 1, updatedAt: 1 },
    { date: '2026-03-06', amount: 99_999_00, projectId: plotA, sourceId: bank, categoryId: masonry, voided: 1, voidedAt: 5, createdAt: 1, updatedAt: 1 },
  ])
  await legacy.table('fundIns').bulkAdd([
    { date: '2026-01-01', sourceId: bank, amount: 2_00_000_00, origin: 'Loan', createdAt: 1 },
    { date: '2026-01-15', sourceId: cash, amount: 50_000_00, origin: 'ATM', projectId: plotA, createdAt: 1 },
  ])
  await legacy.table('settings').bulkPut([
    { key: 'lastBackupAt', value: 1_700_000_000_000 },
    { key: 'currency', value: 'INR' },
  ])

  legacy.close()
  return { plotA, plotB, bank, cash, mestri, masonry, permits, batch }
}

async function clearNew() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(), db.settings.clear(),
  ])
}

beforeEach(async () => {
  await clearNew()
  await Dexie.delete(LEGACY_DB_NAME)
})
afterEach(async () => {
  await Dexie.delete(LEGACY_DB_NAME)
})

describe('migrating off numeric ids', () => {
  it('does nothing when there is no legacy database', async () => {
    const r = await migrateLegacyIfNeeded()
    expect(r.ran).toBe(false)
    expect(r.reason).toBe('no legacy database')
  })

  it('moves every row across', async () => {
    await buildLegacy()
    const r = await migrateLegacyIfNeeded()

    expect(r.ran).toBe(true)
    expect(r.counts).toMatchObject({
      projects: 2, sources: 2, payees: 1, categories: 2, txns: 5, fundIns: 2, importBatches: 1,
    })
    expect(await db.txns.count()).toBe(5)
    expect(await db.fundIns.count()).toBe(2)
  })

  it('preserves the ledger total exactly', async () => {
    await buildLegacy()
    const r = await migrateLegacyIfNeeded()

    // 50,000 + 8,500 + 20,000 - 5,000, with the voided 99,999 excluded.
    expect(r.spentBefore).toBe(73_500_00)
    expect(r.spentAfter).toBe(r.spentBefore)
    expect(sum((await db.txns.toArray()).filter((t) => !t.voided).map((t) => t.amount))).toBe(73_500_00)
  })

  it('gives every record a UUID, and no two the same', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    const ids = [
      ...(await db.txns.toArray()).map((t) => t.id),
      ...(await db.sources.toArray()).map((s) => s.id),
      ...(await db.payees.toArray()).map((p) => p.id),
    ]
    expect(ids.every((id) => typeof id === 'string' && id.length >= 10)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rewires every foreign key to the new ids', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    const sources = await db.sources.toArray()
    const payees = await db.payees.toArray()
    const projects = await db.projects.toArray()
    const categories = await db.categories.toArray()
    const validSource = new Set(sources.map((s) => s.id))
    const validPayee = new Set(payees.map((p) => p.id))
    const validProject = new Set(projects.map((p) => p.id))
    const validCategory = new Set(categories.map((c) => c.id))

    for (const t of await db.txns.toArray()) {
      // A key left pointing at an old number would silently orphan the row.
      expect(validSource.has(t.sourceId)).toBe(true)
      expect(validProject.has(t.projectId)).toBe(true)
      expect(validCategory.has(t.categoryId)).toBe(true)
      if (t.payeeId !== undefined) expect(validPayee.has(t.payeeId)).toBe(true)
    }
    for (const f of await db.fundIns.toArray()) {
      expect(validSource.has(f.sourceId)).toBe(true)
      if (f.projectId !== undefined) expect(validProject.has(f.projectId)).toBe(true)
    }
  })

  it('keeps the relationships meaning the same thing', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    const mestri = (await db.payees.toArray())[0]
    const paidToMestri = (await db.txns.toArray()).filter((t) => t.payeeId === mestri.id)
    expect(sum(paidToMestri.map((t) => t.amount))).toBe(70_000_00)

    const bank = (await db.sources.toArray()).find((s) => s.name === 'ICICI 0763')!
    const balance = (await sourceBalances()).find((b) => b.source.id === bank.id)!
    // 10,000 opening + 2,00,000 in − (50,000 + 20,000 − 5,000) out.
    expect(balance.balance).toBe(1_45_000_00)
  })

  it('preserves voided rows and reversals as they were', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    const voided = (await db.txns.toArray()).filter((t) => t.voided === 1)
    expect(voided).toHaveLength(1)
    expect(voided[0].amount).toBe(99_999_00)

    const reversal = (await db.txns.toArray()).find((t) => t.amount < 0)
    expect(reversal?.amount).toBe(-5_000_00)
  })

  it('carries the archived flag, and adds one to legacy categories', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    expect((await db.sources.toArray()).find((s) => s.name === 'Cash in hand')!.archived).toBe(1)
    // Legacy categories predate the flag; they must arrive unarchived, not undefined.
    expect((await db.categories.toArray()).every((c) => c.archived === 0)).toBe(true)
  })

  it('carries settings over, so the backup nag does not reset', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()
    expect((await db.settings.get('lastBackupAt'))?.value).toBe(1_700_000_000_000)
  })

  it('leaves the legacy database untouched, as a fallback', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()

    expect(await legacyDatabaseExists()).toBe(true)
    const legacy = new Dexie(LEGACY_DB_NAME)
    await legacy.open()
    // Someone's financial history: it stays put until they say otherwise.
    expect(await legacy.table('txns').count()).toBe(5)
    legacy.close()
  })

  it('does not run twice', async () => {
    await buildLegacy()
    await migrateLegacyIfNeeded()
    const again = await migrateLegacyIfNeeded()

    expect(again.ran).toBe(false)
    expect(again.reason).toBe('already migrated')
    expect(await db.txns.count()).toBe(5)
  })

  it('refuses to overwrite a database that already has entries', async () => {
    await buildLegacy()
    const p = (await db.projects.add({ name: 'Typed here', status: 'active', createdAt: 1 } as never)) as string
    const s = (await db.sources.add({ name: 'S', type: 'cash', openingBalance: 0, archived: 0, createdAt: 1 } as never)) as string
    const c = (await db.categories.add({ name: 'C', sortOrder: 1, archived: 0 } as never)) as string
    await db.txns.add({
      date: '2026-04-01', amount: 1_000_00, projectId: p, sourceId: s, categoryId: c,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const r = await migrateLegacyIfNeeded()

    expect(r.ran).toBe(false)
    expect(r.reason).toBe('new database already has entries')
    // The typed entry survives; the legacy rows are not mixed in behind it.
    expect(await db.txns.count()).toBe(1)
  })

  it('skips a legacy database that only ever held the seeded defaults', async () => {
    const legacy = new Dexie(LEGACY_DB_NAME)
    legacy.version(1).stores({
      projects: '++id', sources: '++id', payees: '++id', categories: '++id',
      txns: '++id', fundIns: '++id', importBatches: '++id', settings: 'key',
    })
    await legacy.open()
    await legacy.table('projects').add({ name: 'My first property', status: 'active' })
    await legacy.table('sources').add({ name: 'Cash in hand', type: 'cash', openingBalance: 0, archived: 0 })
    legacy.close()

    const r = await migrateLegacyIfNeeded()
    expect(r.ran).toBe(false)
    expect(r.reason).toMatch(/nothing worth moving/)
  })
})

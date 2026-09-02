import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { seedIfEmpty } from './seed'
import { sourceBalances, sum } from './queries'
import {
  deleteSource,
  mergeSources,
  mergeTargets,
  setSourceArchived,
  sourceUsage,
  updateSource,
} from './manage'

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(), db.settings.clear(),
  ])
  await seedIfEmpty()
}

/**
 * The shape an import leaves behind: one real bank account spelled two ways,
 * with entries split across both.
 */
async function duplicateSources() {
  const projectId = (await db.projects.toArray())[0].id
  const categoryId = (await db.categories.toArray())[0].id

  const a = (await db.sources.add({
    name: 'sbi 4471', type: 'bank', openingBalance: 5_000_00, archived: 0, createdAt: 1,
  } as never)) as number
  const b = (await db.sources.add({
    name: 'SBI 4471', type: 'bank', openingBalance: 2_000_00, archived: 0, createdAt: 1,
  } as never)) as number

  const txn = (sourceId: number, amount: number, date: string) =>
    db.txns.add({
      date, amount, projectId, sourceId, categoryId,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

  await txn(a, 30_000_00, '2026-02-01')
  await txn(a, 10_000_00, '2026-02-05')
  await txn(b, 20_000_00, '2026-03-01')

  await db.fundIns.add({
    date: '2026-01-01', sourceId: a, amount: 1_00_000_00, origin: 'Loan', createdAt: 1,
  } as never)
  await db.fundIns.add({
    date: '2026-01-15', sourceId: b, amount: 50_000_00, origin: 'Savings', createdAt: 1,
  } as never)

  return { a, b, projectId, categoryId }
}

beforeEach(reset)

describe('editing a source', () => {
  it('renames and retypes it, which the importer cannot get right on its own', async () => {
    const { a } = await duplicateSources()

    await updateSource(a, {
      name: 'SBI savings 4471',
      type: 'upi',
      institution: 'State Bank',
      openingBalance: 7_500_00,
      notes: 'joint account',
    })

    const s = (await db.sources.get(a))!
    expect(s.name).toBe('SBI savings 4471')
    expect(s.type).toBe('upi')
    expect(s.institution).toBe('State Bank')
    expect(s.openingBalance).toBe(7_500_00)
    expect(s.notes).toBe('joint account')
  })

  it('trims the name and drops empty optional fields', async () => {
    const { a } = await duplicateSources()
    await updateSource(a, { name: '  HDFC  ', type: 'bank', institution: '  ', openingBalance: 0, notes: '' })

    const s = (await db.sources.get(a))!
    expect(s.name).toBe('HDFC')
    expect(s.institution).toBeUndefined()
    expect(s.notes).toBeUndefined()
  })

  it('refuses renaming onto another source, pointing at merge instead', async () => {
    const { a } = await duplicateSources()
    // The importer matches on name, so a duplicate would split future rows.
    await expect(
      updateSource(a, { name: 'Cash in hand', type: 'bank', openingBalance: 0 }),
    ).rejects.toThrow(/already exists.*[Mm]erge/)
    await expect(
      updateSource(a, { name: 'cash IN hand', type: 'bank', openingBalance: 0 }),
    ).rejects.toThrow(/already exists/)
  })

  it('still allows renaming to something genuinely new', async () => {
    const { a } = await duplicateSources()
    await updateSource(a, { name: 'SBI savings', type: 'bank', openingBalance: 0 })
    expect((await db.sources.get(a))!.name).toBe('SBI savings')
  })

  it('refuses an empty name', async () => {
    const { a } = await duplicateSources()
    await expect(updateSource(a, { name: '   ', type: 'bank', openingBalance: 0 })).rejects.toThrow(
      /needs a name/,
    )
  })

  it('lets a source keep its own name while other fields change', async () => {
    const { a } = await duplicateSources()
    await expect(
      updateSource(a, { name: 'sbi 4471', type: 'cash', openingBalance: 0 }),
    ).resolves.toBeUndefined()
    expect((await db.sources.get(a))!.type).toBe('cash')
  })

  it('can fix the type of one of two case-only duplicates without renaming it', async () => {
    // Exactly what an import leaves behind. Guarding the name unconditionally
    // would lock both of these out of every edit.
    const { a, b } = await duplicateSources()
    expect((await db.sources.get(a))!.name.toLowerCase()).toBe(
      (await db.sources.get(b))!.name.toLowerCase(),
    )

    await updateSource(a, { name: 'sbi 4471', type: 'upi', openingBalance: 5_000_00 })

    expect((await db.sources.get(a))!.type).toBe('upi')
  })
})

describe('archiving', () => {
  it('hides it from the add-payment picker but keeps its history', async () => {
    const { a } = await duplicateSources()

    await setSourceArchived(a, true)

    // The Add screen queries archived=0.
    const pickable = await db.sources.where('archived').equals(0).toArray()
    expect(pickable.map((s) => s.id)).not.toContain(a)

    // History and balances are untouched.
    const b = (await sourceBalances()).find((x) => x.source.id === a)!
    expect(b.outflow).toBe(40_000_00)
    expect(b.txnCount).toBe(2)
  })

  it('is reversible', async () => {
    const { a } = await duplicateSources()
    await setSourceArchived(a, true)
    await setSourceArchived(a, false)
    expect((await db.sources.get(a))!.archived).toBe(0)
  })
})

describe('deleting', () => {
  it('refuses while anything still points at it', async () => {
    const { a } = await duplicateSources()
    // A dangling sourceId would leave payments belonging to no account.
    await expect(deleteSource(a)).rejects.toThrow(/2 payments and 1 inflows/)
    expect(await db.sources.get(a)).toBeDefined()
  })

  it('deletes an unused source', async () => {
    await duplicateSources()
    const spare = (await db.sources.add({
      name: 'Unused wallet', type: 'cash', openingBalance: 0, archived: 0, createdAt: 1,
    } as never)) as number

    expect((await sourceUsage(spare)).inUse).toBe(false)
    await deleteSource(spare)
    expect(await db.sources.get(spare)).toBeUndefined()
  })

  it('refuses to remove the last remaining source', async () => {
    // Seed leaves exactly one; with nothing else, deleting it would leave the
    // Add screen with no source to pick.
    const only = (await db.sources.toArray())[0]
    await expect(deleteSource(only.id)).rejects.toThrow(/only source/)
  })
})

describe('merging two spellings of one account', () => {
  it('moves every payment and inflow across', async () => {
    const { a, b } = await duplicateSources()

    const r = await mergeSources(a, b)

    expect(r.movedTxns).toBe(2)
    expect(r.movedFundIns).toBe(1)
    expect(await db.sources.get(a)).toBeUndefined()
    expect(await db.txns.where('sourceId').equals(a).count()).toBe(0)
    expect(await db.txns.where('sourceId').equals(b).count()).toBe(3)
    expect(await db.fundIns.where('sourceId').equals(b).count()).toBe(2)
  })

  it('preserves the combined balance exactly', async () => {
    const { a, b } = await duplicateSources()

    const before = await sourceBalances()
    const combined =
      before.find((x) => x.source.id === a)!.balance +
      before.find((x) => x.source.id === b)!.balance

    await mergeSources(a, b)

    const after = (await sourceBalances()).find((x) => x.source.id === b)!
    // The whole point of a merge: the money must not move.
    expect(after.balance).toBe(combined)
    expect(after.balance).toBe(after.source.openingBalance + after.inflow - after.outflow)
  })

  it('adds the opening balances together', async () => {
    const { a, b } = await duplicateSources()
    const r = await mergeSources(a, b)

    expect(r.openingBalanceAdded).toBe(5_000_00)
    expect((await db.sources.get(b))!.openingBalance).toBe(7_000_00)
  })

  it('leaves the ledger total unchanged', async () => {
    const { a, b } = await duplicateSources()
    const before = sum((await db.txns.toArray()).map((t) => t.amount))

    await mergeSources(a, b)

    expect(sum((await db.txns.toArray()).map((t) => t.amount))).toBe(before)
  })

  it('rejects merging a source into itself', async () => {
    const { a } = await duplicateSources()
    await expect(mergeSources(a, a)).rejects.toThrow(/different source/)
  })

  it('rejects a target that no longer exists', async () => {
    const { a } = await duplicateSources()
    await expect(mergeSources(a, 99999)).rejects.toThrow(/no longer exists/)
    // The failed merge must not have moved anything.
    expect(await db.txns.where('sourceId').equals(a).count()).toBe(2)
  })

  it('offers every other source as a target, never itself', async () => {
    const { a } = await duplicateSources()
    const t = await mergeTargets(a)
    expect(t.map((x) => x.id)).not.toContain(a)
    expect(t.length).toBe((await db.sources.count()) - 1)
  })
})

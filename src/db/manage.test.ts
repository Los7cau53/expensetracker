import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { seedIfEmpty } from './seed'
import { payeeTotals, sourceBalances, sum } from './queries'
import {
  addCategory,
  deleteFundIn,
  updateFundIn,
  deleteCategory,
  deletePayee,
  deleteProject,
  mergeCategories,
  mergePayees,
  mergeProjects,
  payeeMergeTargets,
  setCategoryArchived,
  setPayeeArchived,
  updateCategory,
  updatePayee,
  updateProject,
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
  } as never)) as string
  const b = (await db.sources.add({
    name: 'SBI 4471', type: 'bank', openingBalance: 2_000_00, archived: 0, createdAt: 1,
  } as never)) as string

  const txn = (sourceId: string, amount: number, date: string) =>
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
    } as never)) as string

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
    await expect(mergeSources(a, 'no-such-id')).rejects.toThrow(/no longer exists/)
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

// ---------------------------------------------------------------------------
// Payees, cost heads, properties — same guarantees as sources.
// ---------------------------------------------------------------------------

/** One mestri entered twice, as an import would leave them. */
async function duplicatePayees() {
  const projectId = (await db.projects.toArray())[0].id
  const sourceId = (await db.sources.toArray())[0].id
  const categoryId = (await db.categories.toArray())[0].id

  const a = (await db.payees.add({
    name: 'Ramesh mestri', role: 'mestri', archived: 0, createdAt: 1,
  } as never)) as string
  const b = (await db.payees.add({
    name: 'ramesh Mestri', role: 'other', archived: 0, createdAt: 1,
  } as never)) as string

  const txn = (payeeId: string, amount: number) =>
    db.txns.add({
      date: '2026-02-01', amount, projectId, sourceId, payeeId, categoryId,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

  await txn(a, 50_000_00)
  await txn(a, 30_000_00)
  await txn(b, 22_000_00)
  return { a, b, projectId, sourceId, categoryId }
}

describe('payees', () => {
  it('renames and re-roles', async () => {
    const { a } = await duplicatePayees()
    await updatePayee(a, { name: 'Ramesh (mason)', role: 'mestri', phone: '9876543210' })
    const p = (await db.payees.get(a))!
    expect(p.name).toBe('Ramesh (mason)')
    expect(p.phone).toBe('9876543210')
  })

  it('refuses renaming onto a different payee', async () => {
    const { a } = await duplicatePayees()
    await db.payees.add({
      name: 'Suresh electrical', role: 'electrician', archived: 0, createdAt: 1,
    } as never)

    await expect(
      updatePayee(a, { name: 'Suresh Electrical', role: 'mestri' }),
    ).rejects.toThrow(/already exists.*[Mm]erge/)
  })

  it('can still fix the role of one of two case-only duplicates', async () => {
    // What an import leaves behind. Guarding unconditionally would lock both
    // of these out of every edit.
    const { b } = await duplicatePayees()
    await updatePayee(b, { name: 'ramesh Mestri', role: 'mestri' })
    expect((await db.payees.get(b))!.role).toBe('mestri')
  })

  it('archiving keeps history but leaves the picker', async () => {
    const { a } = await duplicatePayees()
    await setPayeeArchived(a, true)
    const pickable = await db.payees.where('archived').equals(0).toArray()
    expect(pickable.map((p) => p.id)).not.toContain(a)
    expect((await payeeTotals()).find((t) => t.payee.id === a)!.total).toBe(80_000_00)
  })

  it('refuses deleting a payee that has payments', async () => {
    const { a } = await duplicatePayees()
    await expect(deletePayee(a)).rejects.toThrow(/2 payments/)
  })

  it('merges the duplicate and keeps every payment', async () => {
    const { a, b } = await duplicatePayees()
    const before = sum((await db.txns.toArray()).map((t) => t.amount))

    const r = await mergePayees(b, a)

    expect(r.movedTxns).toBe(1)
    expect(await db.payees.get(b)).toBeUndefined()
    expect((await payeeTotals()).find((t) => t.payee.id === a)!.total).toBe(1_02_000_00)
    // Merging must not move money.
    expect(sum((await db.txns.toArray()).map((t) => t.amount))).toBe(before)
  })

  it('offers every other payee as a target, never itself', async () => {
    const { a } = await duplicatePayees()
    expect((await payeeMergeTargets(a)).map((p) => p.id)).not.toContain(a)
  })
})

describe('cost heads', () => {
  it('renames one', async () => {
    const c = (await db.categories.toArray())[0]
    await updateCategory(c.id, '  Foundation works  ')
    expect((await db.categories.get(c.id))!.name).toBe('Foundation works')
  })

  it('refuses a duplicate name and an empty one', async () => {
    const [a, b] = await db.categories.toArray()
    await expect(updateCategory(a.id, b.name)).rejects.toThrow(/already exists/)
    await expect(updateCategory(a.id, '  ')).rejects.toThrow(/needs a name/)
  })

  it('adds one, rejecting a duplicate', async () => {
    const id = await addCategory('Borewell')
    expect((await db.categories.get(id))!.name).toBe('Borewell')
    await expect(addCategory('borewell')).rejects.toThrow(/already exists/)
  })

  it('archived cost heads leave the picker but keep their entries', async () => {
    const { categoryId } = await duplicatePayees()
    await setCategoryArchived(categoryId, true)

    // The Add screen filters these out.
    const pickable = await db.categories.filter((c) => !c.archived).toArray()
    expect(pickable.map((c) => c.id)).not.toContain(categoryId)
    expect(await db.txns.where('categoryId').equals(categoryId).count()).toBe(3)
  })

  it('refuses deleting one that is in use', async () => {
    const { categoryId } = await duplicatePayees()
    await expect(deleteCategory(categoryId)).rejects.toThrow(/3 payments use this cost head/)
  })

  it('deletes an unused one', async () => {
    const id = await addCategory('Never used')
    await deleteCategory(id)
    expect(await db.categories.get(id)).toBeUndefined()
  })

  it('merges an import artefact into a real cost head', async () => {
    const { categoryId } = await duplicatePayees()
    // The importer files column values as cost heads, junk included.
    const junk = await addCategory('net banking main form')
    const projectId = (await db.projects.toArray())[0].id
    const sourceId = (await db.sources.toArray())[0].id
    await db.txns.add({
      date: '2026-03-01', amount: 1_44_704_14, projectId, sourceId, categoryId: junk,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const r = await mergeCategories(junk, categoryId)

    expect(r.movedTxns).toBe(1)
    expect(await db.categories.get(junk)).toBeUndefined()
    expect(await db.txns.where('categoryId').equals(categoryId).count()).toBe(4)
  })
})

describe('properties', () => {
  async function twoProjects() {
    const a = (await db.projects.toArray())[0].id
    const b = (await db.projects.add({
      name: 'Plot 7', status: 'active', budget: 10_00_000_00, createdAt: 1,
    } as never)) as string
    const sourceId = (await db.sources.toArray())[0].id
    const categoryId = (await db.categories.toArray())[0].id
    await db.txns.add({
      date: '2026-02-01', amount: 40_000_00, projectId: b, sourceId, categoryId,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)
    await db.fundIns.add({
      date: '2026-01-01', sourceId, projectId: b, amount: 5_00_000_00, origin: 'Loan', createdAt: 1,
    } as never)
    return { a, b }
  }

  it('renames and restatuses, and can clear a budget', async () => {
    const { b } = await twoProjects()
    await updateProject(b, { name: 'Plot 7, Kompally', status: 'done', budget: undefined })
    const p = (await db.projects.get(b))!
    expect(p.name).toBe('Plot 7, Kompally')
    expect(p.status).toBe('done')
    expect(p.budget).toBeUndefined()
  })

  it('refuses renaming onto another property', async () => {
    const { a, b } = await twoProjects()
    const other = (await db.projects.get(a))!
    await expect(updateProject(b, { name: other.name, status: 'active' })).rejects.toThrow(
      /already exists/,
    )
  })

  it('refuses deleting one that holds entries', async () => {
    const { b } = await twoProjects()
    await expect(deleteProject(b)).rejects.toThrow(/1 payments and 1 inflows/)
    expect(await db.projects.get(b)).toBeDefined()
  })

  it('deletes an empty property that is not the last', async () => {
    const { a, b } = await twoProjects()
    await deleteProject(a)
    expect(await db.projects.get(a)).toBeUndefined()
    expect(await db.projects.get(b)).toBeDefined()
  })

  it('refuses removing the last property, even when it is empty', async () => {
    // Seed leaves exactly one, with nothing recorded against it.
    const only = (await db.projects.toArray())[0]
    await expect(deleteProject(only.id)).rejects.toThrow(/only property/)
  })

  it('merges properties, moving inflows as well as payments, and summing budgets', async () => {
    const { a, b } = await twoProjects()
    await db.projects.update(a, { budget: 5_00_000_00 })

    const r = await mergeProjects(b, a)

    expect(r.movedTxns).toBe(1)
    expect(r.movedFundIns).toBe(1)
    expect(r.budgetAdded).toBe(10_00_000_00)
    expect((await db.projects.get(a))!.budget).toBe(15_00_000_00)
    expect(await db.projects.get(b)).toBeUndefined()
    expect(await db.txns.where('projectId').equals(a).count()).toBe(1)
    expect(await db.fundIns.where('projectId').equals(a).count()).toBe(1)
  })

  it('rejects merging a property into itself', async () => {
    const { b } = await twoProjects()
    await expect(mergeProjects(b, b)).rejects.toThrow(/different property/)
  })
})

describe('money-in entries', () => {
  async function anInflow() {
    const sourceId = (await db.sources.toArray())[0].id
    const id = (await db.fundIns.add({
      date: '2026-12-02', amount: 50_000_00, sourceId, origin: 'bank cash Sneha',
    } as never)) as string
    return { id, sourceId }
  }

  it('corrects a mistyped date and amount', async () => {
    const { id } = await anInflow()

    await updateFundIn(id, {
      date: '2026-09-02',
      amount: 45_000_00,
      origin: 'bank cash Sneha',
      note: 'corrected',
    })

    const row = (await db.fundIns.get(id))!
    expect(row.date).toBe('2026-09-02')
    expect(row.amount).toBe(45_000_00)
    expect(row.note).toBe('corrected')
  })

  it('moves the source balance by exactly the correction', async () => {
    const { id, sourceId } = await anInflow()
    const before = (await sourceBalances()).find((b) => b.source.id === sourceId)!.balance

    await updateFundIn(id, { date: '2026-09-02', amount: 45_000_00, origin: 'x' })

    const after = (await sourceBalances()).find((b) => b.source.id === sourceId)!.balance
    expect(before - after).toBe(5_000_00)
  })

  it('refuses a zero or negative amount, and a missing date', async () => {
    const { id } = await anInflow()
    await expect(updateFundIn(id, { date: '2026-09-02', amount: 0, origin: 'x' })).rejects.toThrow(
      /more than zero/,
    )
    await expect(
      updateFundIn(id, { date: '', amount: 1_000_00, origin: 'x' }),
    ).rejects.toThrow(/needs a date/)
  })

  it('falls back to a label rather than an empty origin', async () => {
    const { id } = await anInflow()
    await updateFundIn(id, { date: '2026-09-02', amount: 1_000_00, origin: '   ' })
    expect((await db.fundIns.get(id))!.origin).toBe('Funds in')
  })

  it('deletes one, dropping the balance by that much', async () => {
    const { id, sourceId } = await anInflow()
    const before = (await sourceBalances()).find((b) => b.source.id === sourceId)!.balance

    await deleteFundIn(id)

    expect(await db.fundIns.get(id)).toBeUndefined()
    const after = (await sourceBalances()).find((b) => b.source.id === sourceId)!.balance
    expect(before - after).toBe(50_000_00)
  })

  it('leaves a tombstone, so the other device drops it too', async () => {
    const { id } = await anInflow()
    await deleteFundIn(id)

    const stone = await db.tombstones.get(`fundIns:${id}`)
    expect(stone?.table).toBe('fundIns')
    expect(stone?.recordId).toBe(id)
  })
})

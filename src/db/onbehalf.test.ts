import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { owedByPayee, payeeTotals, projectSummary, sourceBalances } from './queries'
import { summarise } from './summary'
import { mergePayees, payeeUsage } from './manage'

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(), db.settings.clear(),
  ])
}

/**
 * The scenario from the brief: X fronts ₹5,000 for the borewell, then gets
 * repaid. The cost head must read ₹5,000 throughout — never ₹10,000.
 */
async function fixture() {
  const plot = (await db.projects.add({ name: 'Plot 42', status: 'active', createdAt: 1 } as never)) as string
  const bank = (await db.sources.add({
    name: 'SBI', type: 'bank', openingBalance: 0, archived: 0, createdAt: 1,
  } as never)) as string
  const x = (await db.payees.add({
    name: 'Partner X', role: 'other', archived: 0, createdAt: 1,
  } as never)) as string
  const bore = (await db.categories.add({ name: 'Borewell', sortOrder: 1, archived: 0, createdAt: 1 } as never)) as string

  return { plot, bank, x, bore }
}

const FIVE_K = 5_000_00

beforeEach(reset)

describe('on-behalf spend and repayment', () => {
  it('recognises the cost without touching a source, and records the debt', async () => {
    const { plot, bank, x, bore } = await fixture()

    await db.txns.add({
      kind: 'onbehalf', date: '2026-01-10', projectId: plot, fronterId: x, categoryId: bore,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const s = await summarise()
    // The cost head reads the fronted amount, and so does net spend.
    expect(s.spent).toBe(FIVE_K)
    expect(s.byCategory.find((c) => c.name === 'Borewell')!.total).toBe(FIVE_K)
    // No account of ours moved: the balance is still its opening figure.
    const balances = await sourceBalances()
    expect(balances.find((b) => b.source.id === bank)!.balance).toBe(0)
    // The source breakdown shows it under "Paid by others", not a real source.
    expect(s.bySource.find((r) => r.name === 'Paid by others')!.total).toBe(FIVE_K)
    // And the debt is surfaced.
    expect(s.totalOwed).toBe(FIVE_K)
    expect(s.owedByFronter).toHaveLength(1)
    expect(s.owedByFronter[0].total).toBe(FIVE_K)
  })

  it('a repayment clears the debt and moves cash, but never re-counts the head', async () => {
    const { plot, bank, x, bore } = await fixture()

    await db.txns.add({
      kind: 'onbehalf', date: '2026-01-10', projectId: plot, fronterId: x, categoryId: bore,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)
    await db.txns.add({
      kind: 'settlement', date: '2026-02-01', projectId: plot, payeeId: x, sourceId: bank,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const s = await summarise()
    // The whole point: the borewell head is ₹5,000, not ₹10,000.
    expect(s.spent).toBe(FIVE_K)
    expect(s.byCategory.find((c) => c.name === 'Borewell')!.total).toBe(FIVE_K)
    // The repayment is the only thing that touched the account.
    const balances = await sourceBalances()
    expect(balances.find((b) => b.source.id === bank)!.balance).toBe(-FIVE_K)
    // Debt is settled.
    expect(s.totalOwed).toBe(0)
    expect(s.owedByFronter).toHaveLength(0)
    expect(await owedByPayee()).toHaveLength(0)
  })

  it('tracks fronted, repaid and owed per payee', async () => {
    const { plot, bank, x, bore } = await fixture()

    await db.txns.add({
      kind: 'onbehalf', date: '2026-01-10', projectId: plot, fronterId: x, categoryId: bore,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const before = (await payeeTotals()).find((t) => t.payee.id === x)!
    expect(before.fronted).toBe(FIVE_K)
    expect(before.repaid).toBe(0)
    expect(before.owed).toBe(FIVE_K)
    expect(before.total).toBe(0) // nothing has reached them yet

    await db.txns.add({
      kind: 'settlement', date: '2026-02-01', projectId: plot, payeeId: x, sourceId: bank,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const after = (await payeeTotals()).find((t) => t.payee.id === x)!
    expect(after.fronted).toBe(FIVE_K)
    expect(after.repaid).toBe(FIVE_K)
    expect(after.owed).toBe(0)
    expect(after.total).toBe(FIVE_K) // the repayment reached them
  })

  it('keeps the borewell head out of the project source breakdown too', async () => {
    const { plot, x, bore } = await fixture()
    await db.txns.add({
      kind: 'onbehalf', date: '2026-01-10', projectId: plot, fronterId: x, categoryId: bore,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const ps = (await projectSummary(plot))!
    expect(ps.spent).toBe(FIVE_K)
    expect(ps.byCategory.find((c) => c.name === 'Borewell')!.total).toBe(FIVE_K)
    expect(ps.bySource.find((r) => r.name === 'Paid by others')!.total).toBe(FIVE_K)
  })

  it('counts a fronter as in-use and moves the debt on a merge', async () => {
    const { plot, x, bore } = await fixture()
    const y = (await db.payees.add({
      name: 'Partner X (dup)', role: 'other', archived: 0, createdAt: 1,
    } as never)) as string

    await db.txns.add({
      kind: 'onbehalf', date: '2026-01-10', projectId: plot, fronterId: x, categoryId: bore,
      amount: FIVE_K, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    // A fronter is referenced, so a delete must be refused / merge offered.
    expect((await payeeUsage(x)).inUse).toBe(true)

    const { movedTxns } = await mergePayees(x, y)
    expect(movedTxns).toBe(1)
    // The debt now belongs to Y, and X is gone.
    expect(await db.payees.get(x)).toBeUndefined()
    const owed = await owedByPayee()
    expect(owed).toHaveLength(1)
    expect(owed[0].payee.id).toBe(y)
    expect(owed[0].owed).toBe(FIVE_K)
  })
})

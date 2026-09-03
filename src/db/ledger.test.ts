import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { seedIfEmpty } from './seed'
import { payeeTotals, projectSummary, sourceBalances, sum } from './queries'
import { buildSnapshot, parseSnapshot, restoreSnapshot } from '../lib/backup'

async function reset() {
  await Promise.all([
    db.projects.clear(),
    db.sources.clear(),
    db.payees.clear(),
    db.categories.clear(),
    db.txns.clear(),
    db.fundIns.clear(),
    db.importBatches.clear(),
    db.settings.clear(),
  ])
  await seedIfEmpty()
}

/** Builds a small but realistic dataset: one property, two sources, two payees. */
async function fixture() {
  const projectId = (await db.projects.add({
    name: 'Plot 42',
    status: 'active',
    createdAt: Date.now(),
  } as never)) as string

  const bankId = (await db.sources.add({
    name: 'SBI savings',
    type: 'bank',
    openingBalance: 5_000_00, // ₹5,000
    archived: 0,
    createdAt: Date.now(),
  } as never)) as string

  const upiId = (await db.sources.add({
    name: 'GPay',
    type: 'upi',
    openingBalance: 0,
    archived: 0,
    createdAt: Date.now(),
  } as never)) as string

  const mestriId = (await db.payees.add({
    name: 'Ramesh mestri',
    role: 'mestri',
    archived: 0,
    createdAt: Date.now(),
  } as never)) as string

  const electricianId = (await db.payees.add({
    name: 'Suresh electrical',
    role: 'electrician',
    archived: 0,
    createdAt: Date.now(),
  } as never)) as string

  const categoryId = (await db.categories.orderBy('sortOrder').first())!.id

  const now = Date.now()
  const txn = (
    amount: number,
    sourceId: string,
    payeeId: string | undefined,
    date: string,
  ) =>
    db.txns.add({
      date,
      projectId,
      amount,
      sourceId,
      payeeId,
      categoryId,
      voided: 0,
      createdAt: now,
      updatedAt: now,
    } as never) as Promise<string>

  // ₹2,00,000 loan money into the bank account.
  await db.fundIns.add({
    date: '2026-01-01',
    sourceId: bankId,
    amount: 2_00_000_00,
    origin: 'HDFC home loan tranche 1',
    createdAt: now,
  } as never)

  const t1 = await txn(50_000_00, bankId, mestriId, '2026-01-10')
  const t2 = await txn(30_000_00, bankId, mestriId, '2026-02-14')
  const t3 = await txn(12_500_00, upiId, electricianId, '2026-02-20')
  const t4 = await txn(1_200_00, upiId, undefined, '2026-03-02') // counter payment

  return { projectId, bankId, upiId, mestriId, electricianId, t1, t2, t3, t4 }
}

beforeEach(reset)

describe('source balances', () => {
  it('holds the identity: opening + inflows - outflows', async () => {
    const { bankId } = await fixture()
    const balances = await sourceBalances()

    for (const b of balances) {
      expect(b.balance).toBe(b.source.openingBalance + b.inflow - b.outflow)
    }

    const bank = balances.find((b) => b.source.id === bankId)!
    // ₹5,000 opening + ₹2,00,000 loan − ₹80,000 paid to the mestri.
    expect(bank.inflow).toBe(2_00_000_00)
    expect(bank.outflow).toBe(80_000_00)
    expect(bank.balance).toBe(1_25_000_00)
    expect(bank.txnCount).toBe(2)
  })

  it('drops a source balance by exactly the amount of a new payment', async () => {
    const { bankId, mestriId, projectId } = await fixture()
    const before = (await sourceBalances()).find((b) => b.source.id === bankId)!.balance
    const categoryId = (await db.categories.orderBy('sortOrder').first())!.id

    await db.txns.add({
      date: '2026-03-05',
      projectId,
      amount: 7_777_77,
      sourceId: bankId,
      payeeId: mestriId,
      categoryId,
      voided: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    const after = (await sourceBalances()).find((b) => b.source.id === bankId)!.balance
    expect(before - after).toBe(7_777_77)
  })
})

describe('payee totals', () => {
  it('sums what each payee has been given', async () => {
    const { mestriId, electricianId } = await fixture()
    const totals = await payeeTotals()

    const mestri = totals.find((t) => t.payee.id === mestriId)!
    expect(mestri.total).toBe(80_000_00)
    expect(mestri.txnCount).toBe(2)
    expect(mestri.lastPaid).toBe('2026-02-14')

    expect(totals.find((t) => t.payee.id === electricianId)!.total).toBe(12_500_00)
  })

  it('leaves unassigned payments out of every payee total', async () => {
    await fixture()
    const totals = await payeeTotals()
    // The ₹1,200 counter payment belongs to no payee.
    expect(sum(totals.map((t) => t.total))).toBe(92_500_00)
  })
})

describe('voiding', () => {
  it('removes the amount from totals but keeps the row', async () => {
    const { t1, bankId, mestriId } = await fixture()

    await db.txns.update(t1, { voided: 1, voidedAt: Date.now(), updatedAt: Date.now() })

    const bank = (await sourceBalances()).find((b) => b.source.id === bankId)!
    expect(bank.outflow).toBe(30_000_00)
    expect(bank.balance).toBe(1_75_000_00)

    const mestri = (await payeeTotals()).find((t) => t.payee.id === mestriId)!
    expect(mestri.total).toBe(30_000_00)

    // The history survives for a later dispute.
    const row = await db.txns.get(t1)
    expect(row).toBeDefined()
    expect(row!.amount).toBe(50_000_00)
    expect(row!.voided).toBe(1)
  })
})

describe('project summary', () => {
  it('splits spend by source, month and payee role', async () => {
    const { projectId } = await fixture()
    const s = (await projectSummary(projectId))!

    expect(s.spent).toBe(93_700_00)
    expect(s.txnCount).toBe(4)
    expect(s.firstDate).toBe('2026-01-10')
    expect(s.lastDate).toBe('2026-03-02')

    expect(s.byMonth.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(s.byMonth.find((m) => m.month === '2026-02')!.total).toBe(42_500_00)

    expect(s.bySource.find((x) => x.name === 'SBI savings')!.total).toBe(80_000_00)
    expect(s.byPayeeRole.find((r) => r.role === 'mestri')!.total).toBe(80_000_00)
    expect(s.byPayeeRole.find((r) => r.role === 'unassigned')!.total).toBe(1_200_00)

    // Every breakdown must reconcile back to the same total.
    for (const rows of [s.byCategory, s.bySource, s.byMonth, s.byPayeeRole]) {
      expect(sum(rows.map((r) => r.total))).toBe(s.spent)
    }
  })
})

describe('backup round trip', () => {
  it('restores counts and totals exactly after a wipe', async () => {
    await fixture()

    const snapshot = await buildSnapshot()
    const serialised = JSON.stringify(snapshot)

    const before = {
      txns: await db.txns.count(),
      payees: await db.payees.count(),
      spent: sum((await db.txns.toArray()).map((t) => t.amount)),
      balances: (await sourceBalances()).map((b) => b.balance),
    }

    // Simulate the browser losing its storage.
    await Promise.all([
      db.txns.clear(),
      db.fundIns.clear(),
      db.payees.clear(),
      db.sources.clear(),
      db.projects.clear(),
      db.categories.clear(),
    ])
    expect(await db.txns.count()).toBe(0)

    const report = await restoreSnapshot(parseSnapshot(serialised))

    expect(report.counts.txns).toBe(before.txns)
    expect(await db.txns.count()).toBe(before.txns)
    expect(await db.payees.count()).toBe(before.payees)
    expect(sum((await db.txns.toArray()).map((t) => t.amount))).toBe(before.spent)
    expect((await sourceBalances()).map((b) => b.balance)).toEqual(before.balances)
  })

  it('refuses a file that is not one of its own backups', async () => {
    expect(() => parseSnapshot('{"hello":"world"}')).toThrow(/not a backup/i)
    expect(() => parseSnapshot('not json at all')).toThrow(/not valid JSON/i)
    expect(() =>
      parseSnapshot(JSON.stringify({ format: 'construction-expenses-backup', formatVersion: 99 })),
    ).toThrow(/newer version/i)
  })
})

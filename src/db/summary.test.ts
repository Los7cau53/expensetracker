import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { seedIfEmpty } from './seed'
import { summarise, withOther } from './summary'
import { sum } from './queries'

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(), db.settings.clear(),
  ])
  await seedIfEmpty()
}

/** Two properties, two sources, a reversal, spread over three months. */
async function fixture() {
  const plotA = (await db.projects.add({ name: 'Plot 42', status: 'active', createdAt: 1 } as never)) as number
  const plotB = (await db.projects.add({ name: 'Plot 7', status: 'active', createdAt: 1 } as never)) as number

  const bank = (await db.sources.add({
    name: 'SBI', type: 'bank', openingBalance: 10_000_00, archived: 0, createdAt: 1,
  } as never)) as number
  const upi = (await db.sources.add({
    name: 'GPay', type: 'upi', openingBalance: 0, archived: 0, createdAt: 1,
  } as never)) as number

  const mestri = (await db.payees.add({
    name: 'Ramesh mestri', role: 'mestri', archived: 0, createdAt: 1,
  } as never)) as number
  const govt = (await db.payees.add({
    name: 'Panchayat', role: 'govt', archived: 0, createdAt: 1,
  } as never)) as number

  const cats = await db.categories.orderBy('sortOrder').toArray()

  await db.fundIns.add({
    date: '2026-01-01', sourceId: bank, amount: 5_00_000_00, origin: 'Loan', createdAt: 1,
  } as never)

  const add = (date: string, amount: number, projectId: number, sourceId: number, payeeId: number | undefined, categoryId: number) =>
    db.txns.add({
      date, amount, projectId, sourceId, payeeId, categoryId,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

  await add('2026-01-10', 50_000_00, plotA, bank, mestri, cats[0].id)
  await add('2026-01-10', 10_000_00, plotA, upi, govt, cats[1].id)
  await add('2026-02-14', 30_000_00, plotA, bank, mestri, cats[0].id)
  await add('2026-03-02', 20_000_00, plotB, upi, undefined, cats[2].id)
  // A reversed online payment must reduce the net, not add to it.
  await add('2026-03-05', -5_000_00, plotA, bank, undefined, cats[1].id)

  // Voided rows must not reach any widget.
  await db.txns.add({
    date: '2026-02-01', amount: 99_999_00, projectId: plotA, sourceId: bank,
    categoryId: cats[0].id, voided: 1, voidedAt: 2, createdAt: 1, updatedAt: 1,
  } as never)

  return { plotA, plotB, bank, upi, mestri, govt }
}

beforeEach(reset)

describe('summarise', () => {
  it('nets the spend and ignores voided rows', async () => {
    await fixture()
    const s = await summarise()
    // 50k + 10k + 30k + 20k - 5k
    expect(s.spent).toBe(1_05_000_00)
    expect(s.txnCount).toBe(5)
    expect(s.firstDate).toBe('2026-01-10')
    expect(s.lastDate).toBe('2026-03-05')
  })

  it('counts opening balances toward funds in only for the unscoped view', async () => {
    const { plotA } = await fixture()

    const all = await summarise()
    expect(all.fundsIn).toBe(5_00_000_00 + 10_000_00)
    expect(all.available).toBe(all.fundsIn - all.spent)

    // Scoped to a property, an opening balance is not attributable.
    const scoped = await summarise({ projectId: plotA })
    expect(scoped.fundsIn).toBe(5_00_000_00)
  })

  it('builds a cumulative timeline, one point per active date', async () => {
    await fixture()
    const { timeline } = await summarise()

    expect(timeline.map((p) => p.date)).toEqual([
      '2026-01-10', '2026-02-14', '2026-03-02', '2026-03-05',
    ])
    // Two payments share the first date and collapse into one point.
    expect(timeline[0].daily).toBe(60_000_00)
    expect(timeline[0].cumulative).toBe(60_000_00)
    // The running total is monotonic except across the reversal.
    expect(timeline[2].cumulative).toBe(1_10_000_00)
    expect(timeline[3].cumulative).toBe(1_05_000_00)
    // The last cumulative point must equal the headline figure.
    expect(timeline[timeline.length - 1].cumulative).toBe((await summarise()).spent)
  })

  it('every breakdown reconciles to the same total', async () => {
    await fixture()
    const s = await summarise()

    for (const rows of [s.byCategory, s.bySource, s.byProject, s.byMonth, s.byRole]) {
      expect(sum(rows.map((r) => r.total))).toBe(s.spent)
    }
    // Payee totals exclude the two unassigned rows, so they sum to less.
    expect(sum(s.byPayee.map((p) => p.total))).toBe(90_000_00)
  })

  it('splits by month in chronological order', async () => {
    await fixture()
    const { byMonth } = await summarise()
    expect(byMonth).toEqual([
      { month: '2026-01', total: 60_000_00 },
      { month: '2026-02', total: 30_000_00 },
      { month: '2026-03', total: 15_000_00 },
    ])
  })

  it('keeps months with no activity, so the time axis stays continuous', async () => {
    const cats = await db.categories.toArray()
    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const add = (date: string, amount: number) =>
      db.txns.add({
        date, amount, projectId: project.id, sourceId: source.id, categoryId: cats[0].id,
        voided: 0, createdAt: 1, updatedAt: 1,
      } as never)

    await add('2026-02-10', 1_000_00)
    await add('2026-08-10', 2_000_00)

    const { byMonth } = await summarise()
    // Without the gap fill, February would sit next to August and read as
    // two consecutive months.
    expect(byMonth.map((m) => m.month)).toEqual([
      '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
    ])
    expect(byMonth.find((m) => m.month === '2026-05')!.total).toBe(0)
  })

  it('attributes unassigned payments to an "unassigned" role, not a payee', async () => {
    await fixture()
    const { byRole } = await summarise()
    expect(byRole.find((r) => r.role === 'unassigned')!.total).toBe(15_000_00)
    expect(byRole.find((r) => r.role === 'mestri')!.total).toBe(80_000_00)
  })

  it('scopes every series to one property', async () => {
    const { plotB } = await fixture()
    const s = await summarise({ projectId: plotB })

    expect(s.spent).toBe(20_000_00)
    expect(s.byProject).toHaveLength(1)
    expect(s.byProject[0].name).toBe('Plot 7')
    expect(s.timeline).toHaveLength(1)
  })

  it('scopes to a date range', async () => {
    await fixture()
    const s = await summarise({ from: '2026-02-01', to: '2026-02-28' })

    expect(s.spent).toBe(30_000_00)
    expect(s.txnCount).toBe(1)
    expect(s.byMonth).toEqual([{ month: '2026-02', total: 30_000_00 }])
  })

  it('returns an empty, safe shape when nothing matches', async () => {
    await fixture()
    const s = await summarise({ from: '2030-01-01' })

    expect(s.spent).toBe(0)
    expect(s.txnCount).toBe(0)
    expect(s.timeline).toEqual([])
    expect(s.byCategory).toEqual([])
    expect(s.firstDate).toBeUndefined()
  })
})

describe('withOther', () => {
  const rows = [
    { name: 'a', total: 100 }, { name: 'b', total: 90 }, { name: 'c', total: 80 },
    { name: 'd', total: 70 }, { name: 'e', total: 60 },
  ]

  it('leaves a short list alone', () => {
    expect(withOther(rows, 5)).toHaveLength(5)
    expect(withOther(rows, 9)).toHaveLength(5)
  })

  it('folds the tail into one Other row, preserving the total', () => {
    const out = withOther(rows, 3)

    expect(out).toHaveLength(4)
    expect(out[3]).toEqual({ name: 'Other (2)', total: 130, isOther: true })
    // Capping the palette must never change the sum.
    expect(sum(out.map((r) => r.total))).toBe(sum(rows.map((r) => r.total)))
  })

  it('keeps a large negative in its own row instead of burying it in Other', () => {
    // A reversed payment is the most surprising number on the page; ranking by
    // signed value would sort it last and sweep it into the tail.
    const withReversal = [
      { name: 'big spend', total: 220 },
      { name: 'small a', total: 12 },
      { name: 'small b', total: 9 },
      { name: 'small c', total: 7 },
      { name: 'reversal', total: -141 },
    ]
    const out = withOther(withReversal, 3)

    // Kept by magnitude: 220, -141, 12. Displayed in signed order, so the
    // reversal reads as the one row below the line.
    expect(out.map((r) => r.name)).toEqual(['big spend', 'small a', 'reversal', 'Other (2)'])
    expect(out.find((r) => r.name === 'reversal')!.total).toBe(-141)
    // Only the genuinely small rows fold away.
    expect(out.find((r) => r.isOther)!.total).toBe(16)
    expect(sum(out.map((r) => r.total))).toBe(sum(withReversal.map((r) => r.total)))
  })
})

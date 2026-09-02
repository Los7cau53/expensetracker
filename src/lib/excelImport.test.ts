import { beforeEach, describe, expect, it } from 'vitest'
import {
  analyze,
  commitImport,
  defaultAliases,
  EMPTY_MAPPING,
  guessHeader,
  guessMapping,
  type Cell,
} from './excelImport'
import { undoImport } from '../db/imports'
import { db } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import { projectSummary, sourceBalances, sum } from '../db/queries'

/** A sheet shaped like a real hand-kept construction expense file. */
const SHEET: Cell[][] = [
  ['House construction expenses', null, null, null, null],
  [null, null, null, null, null],
  ['Date', 'Paid To', 'Particulars', 'Amount', 'Paid From'],
  ['05/01/2026', 'Ramesh Mestri', 'Foundation work', 50000, 'SBI'],
  ['12/01/2026', 'ramesh mestri', 'Slab centering', '30,000', 'SBI'],
  ['18/01/2026', 'Suresh Electrical', 'Wiring advance', '₹12,500', 'GPay'],
  ['20/01/2026', 'Panchayat office', 'Building permission', 8500, 'Cash'],
  ['bad date', 'Someone', 'Broken row', 1000, 'Cash'],
  ['25/01/2026', 'Someone', 'No amount here', 'n/a', 'Cash'],
  [null, null, null, null, null],
  ['28/01/2026', 'RAMESH MESTRI', 'Brickwork', 22000, 'sbi'],
]

beforeEach(async () => {
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
})

describe('sheet detection', () => {
  it('finds the header row below the title and blank rows', () => {
    expect(guessHeader(SHEET)).toEqual({ headerRow: 2, hasHeader: true })
  })

  it('skips a template block and finds the header that sits on top of the data', () => {
    // Shaped like an expense-report template: several title-ish rows above
    // the real column headings.
    const templated: Cell[][] = [
      ['Your Company', null, null],
      ['Name', 'Employee ID', 'Department'],
      ['Employee name', '#111111', 'Department name'],
      ['Date', 'Description', 'Amount'],
      [new Date(2026, 1, 3), 'cash', 10000],
    ]
    expect(guessHeader(templated)).toEqual({ headerRow: 3, hasHeader: true })
  })

  it('reports that a sheet starting straight in on data has no header', () => {
    // Losing row 1 to a phantom header would silently drop a payment.
    const noHeader: Cell[][] = [
      ['23/08/2026', 'upi from dad', 5000],
      ['28/08/2026', 'upi from dad', 4000],
    ]
    expect(guessHeader(noHeader)).toEqual({ headerRow: 0, hasHeader: false })
  })

  it('pre-fills the column mapping from the header titles', () => {
    const m = guessMapping(SHEET[2])
    expect(m.date).toBe(0)
    expect(m.payee).toBe(1)
    expect(m.category).toBe(2)
    expect(m.amount).toBe(3)
    expect(m.source).toBe(4)
  })
})

describe('analyze', () => {
  const mapping = guessMapping(SHEET[2])

  it('parses the good rows and totals them', () => {
    const a = analyze(SHEET, 2, mapping)
    expect(a.valid).toHaveLength(5)
    // 50,000 + 30,000 + 12,500 + 8,500 + 22,000 = 1,23,000
    expect(a.total).toBe(1_23_000_00)
    expect(a.valid[0].date).toBe('2026-01-05')
    expect(a.valid[0].amount).toBe(50_000_00)
  })

  it('explains every rejection instead of dropping rows quietly', () => {
    const a = analyze(SHEET, 2, mapping)
    expect(a.rejected).toHaveLength(2)
    expect(a.rejected.map((r) => r.reason).sort()).toEqual([
      'No readable amount',
      'No readable date',
    ])
    // Row numbers match what Excel shows, so the user can go and look.
    expect(a.rejected.map((r) => r.sheetRow)).toEqual([8, 9])
  })

  it('collects distinct dimension values', () => {
    const a = analyze(SHEET, 2, mapping)
    expect(a.distinct.payee).toContain('Ramesh Mestri')
    expect(a.distinct.source.length).toBeGreaterThan(1)
  })
})

describe('alias merging', () => {
  it('collapses case and spacing variants onto one canonical name', () => {
    const a = analyze(SHEET, 2, guessMapping(SHEET[2]))
    const aliases = defaultAliases(a.distinct)

    const mestriTargets = new Set(
      ['Ramesh Mestri', 'ramesh mestri', 'RAMESH MESTRI'].map((v) => aliases.payee[v]),
    )
    expect(mestriTargets.size).toBe(1)

    expect(new Set(['SBI', 'sbi'].map((v) => aliases.source[v])).size).toBe(1)
  })
})

describe('commit and undo', () => {
  const mapping = guessMapping(SHEET[2])

  async function runImport() {
    const a = analyze(SHEET, 2, mapping)
    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]
    const res = await commitImport(a, defaultAliases(a.distinct), {
      fileName: 'expenses.xlsx',
      sheetName: 'Sheet1',
      headerRow: 2,
      mapping,
      fallbackProjectId: project.id,
      fallbackSourceId: source.id,
      fallbackCategoryId: category.id,
    })
    return { analysis: a, res }
  }

  it('writes the rows and reconciles to the previewed total', async () => {
    const { analysis, res } = await runImport()

    expect(res.inserted).toBe(analysis.valid.length)
    const stored = await db.txns.toArray()
    expect(stored).toHaveLength(5)
    expect(sum(stored.map((t) => t.amount))).toBe(analysis.total)
  })

  it('creates one payee per canonical name, not one per spelling', async () => {
    await runImport()
    const payees = await db.payees.toArray()
    const mestris = payees.filter((p) => /ramesh/i.test(p.name))
    expect(mestris).toHaveLength(1)
    // The role is inferred from the name so reports work without hand-tagging.
    expect(mestris[0].role).toBe('mestri')
    expect(payees.find((p) => /panchayat/i.test(p.name))!.role).toBe('govt')
  })

  it('infers source types from their names', async () => {
    await runImport()
    const sources = await db.sources.toArray()
    expect(sources.find((s) => /gpay/i.test(s.name))!.type).toBe('upi')
    expect(sources.find((s) => /^sbi$/i.test(s.name))!.type).toBe('bank')
  })

  it('does not create a duplicate when importing onto existing names', async () => {
    await runImport()
    const firstCount = await db.payees.count()
    await runImport()
    // Second import adds transactions but reuses every payee.
    expect(await db.payees.count()).toBe(firstCount)
    expect(await db.txns.count()).toBe(10)
  })

  it('undoes a whole batch back to the prior state', async () => {
    const { res } = await runImport()
    expect(await db.txns.count()).toBe(5)

    const removed = await undoImport(res.batchId)

    expect(removed).toEqual({ txns: 5, fundIns: 0 })
    expect(await db.txns.count()).toBe(0)
    expect(await db.importBatches.count()).toBe(0)
  })

  it('undoes only the named batch', async () => {
    const first = await runImport()
    await runImport()
    expect(await db.txns.count()).toBe(10)

    await undoImport(first.res.batchId)

    expect(await db.txns.count()).toBe(5)
    expect(await db.importBatches.count()).toBe(1)
  })
})

/**
 * These fixtures mirror the awkward shapes in a real hand-kept workbook:
 * one tab per job, inconsistent column orders, no headers, embedded totals,
 * a tab with no date column at all, and a reversed online payment.
 */
describe('real-world sheet shapes', () => {
  it('imports the first row of a sheet that has no header', () => {
    const sheet: Cell[][] = [
      ['23/08/2026', 'upi from dad', 5000],
      ['28/08/2026', 'sent to dad upi', 9000],
    ]
    const mapping = { ...EMPTY_MAPPING, date: 0, source: 1, amount: 2 }

    const withHeader = analyze(sheet, 0, mapping, { hasHeader: true })
    expect(withHeader.valid).toHaveLength(1) // row 1 wrongly eaten as a header

    const noHeader = analyze(sheet, 0, mapping, { hasHeader: false })
    expect(noHeader.valid).toHaveLength(2)
    expect(noHeader.total).toBe(14_000_00)
  })

  it('handles a column order that puts the date last', () => {
    const sheet: Cell[][] = [
      ['upi gpay', 'stone break', 10000, '24/08/2026'],
      ['upi gpay', 'stone break', 16000, '26/08/2026'],
    ]
    const a = analyze(sheet, 0, { ...EMPTY_MAPPING, source: 0, category: 1, amount: 2, date: 3 }, {
      hasHeader: false,
    })
    expect(a.valid).toHaveLength(2)
    expect(a.valid[0].date).toBe('2026-08-24')
    expect(a.total).toBe(26_000_00)
  })

  it('rejects embedded total and signature rows instead of double-counting', () => {
    const sheet: Cell[][] = [
      ['Date', 'Description', 'Amount'],
      ['03/02/2026', 'cash', 10000],
      ['20/02/2026', 'cash', 70000],
      ['Total', null, 80000],
      ['Signature', null, null],
    ]
    const a = analyze(sheet, 0, { ...EMPTY_MAPPING, date: 0, category: 1, amount: 2 })

    expect(a.valid).toHaveLength(2)
    expect(a.total).toBe(80_000_00) // not 1,60,000
    expect(a.rejected.map((r) => r.reason)).toContain('Looks like a total or signature row')
  })

  it('imports a sheet with no date column when given a fallback date', () => {
    const sheet: Cell[][] = [
      ['net banking main form', null, 144704.14],
      ['to somnath reddy upi', null, 10000],
      ['net banking again reverse', null, -141007],
      ['to somnath cash', null, 30000],
      [' permit again online form', null, 144704.14],
      ['Total for permit', null, 188401.28],
    ]
    const mapping = { ...EMPTY_MAPPING, category: 0, amount: 2 }

    const without = analyze(sheet, 0, mapping, { hasHeader: false })
    expect(without.valid).toHaveLength(0)
    expect(without.rejected.every((r) => /date|total/i.test(r.reason))).toBe(true)

    const withDate = analyze(sheet, 0, mapping, {
      hasHeader: false,
      fallbackDate: '2026-08-20',
    })
    expect(withDate.valid).toHaveLength(5)
    expect(withDate.valid.every((r) => r.date === '2026-08-20')).toBe(true)

    // The reversal must reduce the net, and the net must match the sheet total.
    expect(withDate.inflow).toBe(1_41_007_00)
    expect(withDate.outflow).toBe(3_29_408_28)
    expect(withDate.total).toBe(1_88_401_28)
  })

  it('nets a reversal out of source balances and payee totals', async () => {
    const sheet: Cell[][] = [
      ['online form', 144704.14],
      ['reversed', -141007],
    ]
    const a = analyze(sheet, 0, { ...EMPTY_MAPPING, category: 0, amount: 1 }, {
      hasHeader: false,
      fallbackDate: '2026-08-20',
    })

    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]
    await commitImport(a, defaultAliases(a.distinct), {
      fileName: 'x.xlsx',
      sheetName: 'application',
      headerRow: 0,
      mapping: { ...EMPTY_MAPPING, category: 0, amount: 1 },
      fallbackProjectId: project.id,
      fallbackSourceId: source.id,
      fallbackCategoryId: category.id,
    })

    const balances = await sourceBalances()
    const used = balances.find((b) => b.source.id === source.id)!
    // Net outflow, not the gross of both rows.
    expect(used.outflow).toBe(3_697_14)
  })

  it('uses the sheet name as the cost head for rows with no category', async () => {
    const sheet: Cell[][] = [
      ['30/08/2026', 'gpay online', 15850],
    ]
    const mapping = { ...EMPTY_MAPPING, date: 0, source: 1, amount: 2 }
    const a = analyze(sheet, 0, mapping, { hasHeader: false })

    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]
    await commitImport(a, defaultAliases(a.distinct), {
      fileName: 'x.xlsx',
      sheetName: 'electricity',
      headerRow: 0,
      mapping,
      fallbackProjectId: project.id,
      fallbackSourceId: source.id,
      fallbackCategoryId: category.id,
      fallbackCategoryName: 'electricity',
    })

    const created = await db.categories.where('name').equals('electricity').first()
    expect(created).toBeDefined()
    const txn = (await db.txns.toArray())[0]
    expect(txn.categoryId).toBe(created!.id)
  })
})

describe('importing a funding tab as inflows', () => {
  /** Shaped like the "cash" tab: withdrawals and transfers INTO the site float. */
  const CASH_SHEET: Cell[][] = [
    ['Date', 'Category', 'Description', 'Amount'],
    ['03/02/2026', 'cash home', null, 10000],
    ['15/02/2026', 'bank cash', null, 50000],
    ['16/02/2026', 'atm teja', '10k each txn', 20000],
    ['Total', null, null, 80000],
  ]
  const mapping = { ...EMPTY_MAPPING, date: 0, category: 1, note: 2, amount: 3 }

  async function importCash(asFundIns: boolean) {
    const a = analyze(CASH_SHEET, 0, mapping)
    const [project, source, category] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    const res = await commitImport(a, defaultAliases(a.distinct), {
      fileName: 'x.xlsx',
      sheetName: 'cash',
      headerRow: 0,
      mapping,
      fallbackProjectId: project[0].id,
      fallbackSourceId: source[0].id,
      fallbackCategoryId: category[0].id,
      asFundIns,
    })
    return { analysis: a, res, sourceId: source[0].id }
  }

  it('writes fund inflows instead of payments', async () => {
    const { res } = await importCash(true)

    expect(res.asFundIns).toBe(true)
    expect(res.inserted).toBe(3)
    expect(await db.fundIns.count()).toBe(3)
    expect(await db.txns.count()).toBe(0)
  })

  it('raises the source balance rather than counting as spending', async () => {
    const { sourceId } = await importCash(true)

    const balance = (await sourceBalances()).find((b) => b.source.id === sourceId)!
    expect(balance.inflow).toBe(80_000_00)
    expect(balance.outflow).toBe(0)
    expect(balance.balance).toBe(80_000_00)

    // Nothing shows up as project spend, which is the double-count this avoids.
    const project = (await db.projects.toArray())[0]
    expect((await projectSummary(project.id))!.spent).toBe(0)
  })

  it('keeps the sheet label as the origin of the money', async () => {
    await importCash(true)
    const origins = (await db.fundIns.toArray()).map((f) => f.origin).sort()
    expect(origins).toEqual(['atm teja', 'bank cash', 'cash home'])
  })

  it('imports the same sheet as spending when the toggle is off', async () => {
    const { sourceId } = await importCash(false)

    expect(await db.txns.count()).toBe(3)
    expect(await db.fundIns.count()).toBe(0)
    const balance = (await sourceBalances()).find((b) => b.source.id === sourceId)!
    expect(balance.outflow).toBe(80_000_00)
  })

  it('undoes an inflow batch as cleanly as a payment batch', async () => {
    const { res } = await importCash(true)
    expect(await db.fundIns.count()).toBe(3)

    const removed = await undoImport(res.batchId)

    expect(removed).toEqual({ txns: 0, fundIns: 3 })
    expect(await db.fundIns.count()).toBe(0)
    expect(await db.importBatches.count()).toBe(0)
  })
})

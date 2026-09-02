import { db } from './schema'
import type { Paise } from '../lib/money'
import { monthOf, type DateStr } from '../lib/date'
import { sum } from './queries'

export interface SummaryFilter {
  projectId?: number
  from?: DateStr
  to?: DateStr
}

export interface Slice {
  id: number
  name: string
  total: Paise
}

export interface SummaryData {
  /** Net of reversals — the figure the dashboard leads with. */
  spent: Paise
  fundsIn: Paise
  available: Paise
  txnCount: number
  payeeCount: number
  firstDate?: DateStr
  lastDate?: DateStr

  /** Running total by date — the timeline. */
  timeline: { date: DateStr; cumulative: Paise; daily: Paise }[]
  byMonth: { month: string; total: Paise }[]
  byCategory: Slice[]
  bySource: Slice[]
  byPayee: (Slice & { role: string })[]
  byProject: Slice[]
  byRole: { role: string; total: Paise }[]
}

/**
 * One pass over the ledger producing every series the summary screen draws,
 * so all widgets agree on the same slice and the same totals.
 */
export async function summarise(filter: SummaryFilter = {}): Promise<SummaryData> {
  const [allTxns, fundIns, sources, projects, payees, categories] = await Promise.all([
    db.txns.where('voided').equals(0).toArray(),
    db.fundIns.toArray(),
    db.sources.toArray(),
    db.projects.toArray(),
    db.payees.toArray(),
    db.categories.toArray(),
  ])

  const inRange = (d: DateStr) =>
    (!filter.from || d >= filter.from) && (!filter.to || d <= filter.to)

  const txns = allTxns.filter(
    (t) => (!filter.projectId || t.projectId === filter.projectId) && inRange(t.date),
  )

  // Opening balances belong to a source, not to a project or a date window, so
  // they only count toward "funds in" for the unscoped all-time view.
  const unscoped = !filter.projectId && !filter.from && !filter.to
  const scopedFundIns = fundIns.filter(
    (f) =>
      (!filter.projectId || f.projectId === filter.projectId || f.projectId === undefined) &&
      inRange(f.date),
  )
  const fundsIn =
    sum(scopedFundIns.map((f) => f.amount)) +
    (unscoped ? sum(sources.map((s) => s.openingBalance)) : 0)

  const spent = sum(txns.map((t) => t.amount))
  const dates = txns.map((t) => t.date).sort()

  // --- timeline: one point per date that has activity, carrying a running total
  const perDay = new Map<DateStr, Paise>()
  for (const t of txns) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amount)
  let running = 0
  const timeline = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, daily]) => {
      running += daily
      return { date, cumulative: running, daily }
    })

  const named = <T extends { id: number; name: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.id, r.name]))
  const catName = named(categories)
  const srcName = named(sources)
  const projName = named(projects)
  const payeeById = new Map(payees.map((p) => [p.id, p]))

  const group = (key: (t: typeof txns[number]) => number | undefined) => {
    const m = new Map<number, Paise>()
    for (const t of txns) {
      const k = key(t)
      if (k === undefined) continue
      m.set(k, (m.get(k) ?? 0) + t.amount)
    }
    return m
  }

  const toSlices = (m: Map<number, Paise>, names: Map<number, string>, fallback: string) =>
    [...m.entries()]
      .map(([id, total]) => ({ id, name: names.get(id) ?? fallback, total }))
      .sort((a, b) => b.total - a.total)

  const byMonthMap = new Map<string, Paise>()
  for (const t of txns) {
    const m = monthOf(t.date)
    byMonthMap.set(m, (byMonthMap.get(m) ?? 0) + t.amount)
  }
  // Months with no activity still have to appear: dropping them would place
  // February next to August and read as two consecutive months.
  for (const m of monthsBetween(dates[0], dates[dates.length - 1])) {
    if (!byMonthMap.has(m)) byMonthMap.set(m, 0)
  }

  const roleMap = new Map<string, Paise>()
  for (const t of txns) {
    const role = t.payeeId ? payeeById.get(t.payeeId)?.role ?? 'other' : 'unassigned'
    roleMap.set(role, (roleMap.get(role) ?? 0) + t.amount)
  }

  const payeeTotals = group((t) => t.payeeId)

  return {
    spent,
    fundsIn,
    available: fundsIn - spent,
    txnCount: txns.length,
    payeeCount: payeeTotals.size,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    timeline,
    byMonth: [...byMonthMap.entries()]
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    byCategory: toSlices(group((t) => t.categoryId), catName, 'Uncategorised'),
    bySource: toSlices(group((t) => t.sourceId), srcName, 'Unknown source'),
    byPayee: [...payeeTotals.entries()]
      .map(([id, total]) => ({
        id,
        name: payeeById.get(id)?.name ?? 'Unknown',
        role: payeeById.get(id)?.role ?? 'other',
        total,
      }))
      .sort((a, b) => b.total - a.total),
    byProject: toSlices(group((t) => t.projectId), projName, 'Unknown property'),
    byRole: [...roleMap.entries()]
      .map(([role, total]) => ({ role, total }))
      .sort((a, b) => b.total - a.total),
  }
}

/** Inclusive list of 'YYYY-MM' between two dates. */
function monthsBetween(from?: DateStr, to?: DateStr): string[] {
  if (!from || !to) return []
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ey, em] = to.slice(0, 7).split('-').map(Number)
  // Guard against a pathological range producing an unbounded list.
  for (let i = 0; i < 600 && (y < ey || (y === ey && m <= em)); i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

/**
 * Collapses a long tail into an "Other" row. Charts cap at a handful of colored
 * classes; past that, adjacent classes blur and a generated hue would fail
 * every colorblind check.
 *
 * Which rows survive is decided by **magnitude**, not signed value. Ranking by
 * signed value buries a large reversal at the bottom of the list, where it gets
 * swept into "Other" — hiding the single most surprising number on the page.
 */
export function withOther<T extends { name: string; total: Paise }>(
  rows: T[],
  keep: number,
): { name: string; total: Paise; isOther?: boolean }[] {
  if (rows.length <= keep) return rows

  const byMagnitude = [...rows].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  const head = byMagnitude.slice(0, keep).sort((a, b) => b.total - a.total)
  const tail = byMagnitude.slice(keep)

  return [
    ...head,
    { name: `Other (${tail.length})`, total: sum(tail.map((r) => r.total)), isOther: true },
  ]
}

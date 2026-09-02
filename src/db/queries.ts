import { db, type Payee, type Project, type Source, type Txn } from './schema'
import type { Paise } from '../lib/money'
import { monthOf, type DateStr } from '../lib/date'

/** Only non-voided transactions count toward any total. */
const live = () => db.txns.where('voided').equals(0)

export interface SourceBalance {
  source: Source
  inflow: Paise
  outflow: Paise
  balance: Paise
  txnCount: number
}

/**
 * balance = openingBalance + inflows - outflows.
 * This identity is the app's central promise, so it is computed in one place
 * and asserted in tests rather than recalculated per screen.
 */
export async function sourceBalances(projectId?: number): Promise<SourceBalance[]> {
  const [sources, fundIns, txns] = await Promise.all([
    db.sources.toArray(),
    db.fundIns.toArray(),
    live().toArray(),
  ])

  const scopedTxns = projectId ? txns.filter((t) => t.projectId === projectId) : txns
  const scopedFundIns = projectId
    ? fundIns.filter((f) => f.projectId === projectId || f.projectId === undefined)
    : fundIns

  return sources
    .map((source) => {
      const inflow = sum(scopedFundIns.filter((f) => f.sourceId === source.id).map((f) => f.amount))
      const mine = scopedTxns.filter((t) => t.sourceId === source.id)
      const outflow = sum(mine.map((t) => t.amount))
      return {
        source,
        inflow,
        outflow,
        // Opening balance is a property of the source, not of a project, so it
        // only enters the balance in the unscoped (all-projects) view.
        balance: (projectId ? 0 : source.openingBalance) + inflow - outflow,
        txnCount: mine.length,
      }
    })
    .sort((a, b) => Number(a.source.archived) - Number(b.source.archived) || b.outflow - a.outflow)
}

export interface PayeeTotal {
  payee: Payee
  total: Paise
  txnCount: number
  lastPaid?: DateStr
  byProject: { projectId: number; total: Paise }[]
}

/** Answers "how much has this person been paid, and on which property". */
export async function payeeTotals(projectId?: number): Promise<PayeeTotal[]> {
  const [payees, txns] = await Promise.all([db.payees.toArray(), live().toArray()])
  const scoped = projectId ? txns.filter((t) => t.projectId === projectId) : txns

  return payees
    .map((payee) => {
      const mine = scoped.filter((t) => t.payeeId === payee.id)
      const byProject = groupSum(mine, (t) => t.projectId).map(([id, total]) => ({
        projectId: id,
        total,
      }))
      return {
        payee,
        total: sum(mine.map((t) => t.amount)),
        txnCount: mine.length,
        lastPaid: mine.length ? mine.reduce((a, t) => (t.date > a ? t.date : a), mine[0].date) : undefined,
        byProject: byProject.sort((a, b) => b.total - a.total),
      }
    })
    .sort((a, b) => b.total - a.total)
}

export interface ProjectSummary {
  project: Project
  spent: Paise
  txnCount: number
  byCategory: { id: number; name: string; total: Paise }[]
  bySource: { id: number; name: string; total: Paise }[]
  byPayeeRole: { role: string; total: Paise }[]
  byMonth: { month: string; total: Paise }[]
  firstDate?: DateStr
  lastDate?: DateStr
}

export async function projectSummary(projectId: number): Promise<ProjectSummary | null> {
  const project = await db.projects.get(projectId)
  if (!project) return null

  const [txns, categories, sources, payees] = await Promise.all([
    db.txns.where('[projectId+voided]').equals([projectId, 0]).toArray(),
    db.categories.toArray(),
    db.sources.toArray(),
    db.payees.toArray(),
  ])

  const catName = nameMap(categories)
  const srcName = nameMap(sources)
  const roleOf = new Map(payees.map((p) => [p.id, p.role]))
  const dates = txns.map((t) => t.date).sort()

  return {
    project,
    spent: sum(txns.map((t) => t.amount)),
    txnCount: txns.length,
    byCategory: groupSum(txns, (t) => t.categoryId)
      .map(([id, total]) => ({ id, name: catName.get(id) ?? 'Uncategorised', total }))
      .sort((a, b) => b.total - a.total),
    bySource: groupSum(txns, (t) => t.sourceId)
      .map(([id, total]) => ({ id, name: srcName.get(id) ?? 'Unknown', total }))
      .sort((a, b) => b.total - a.total),
    byPayeeRole: groupSumBy(txns, (t) => (t.payeeId ? roleOf.get(t.payeeId) ?? 'other' : 'unassigned'))
      .map(([role, total]) => ({ role, total }))
      .sort((a, b) => b.total - a.total),
    byMonth: groupSumBy(txns, (t) => monthOf(t.date))
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  }
}

export interface TxnFilter {
  projectId?: number
  sourceId?: number
  payeeId?: number
  categoryId?: number
  from?: DateStr
  to?: DateStr
  search?: string
  includeVoided?: boolean
}

export async function filterTxns(f: TxnFilter): Promise<Txn[]> {
  let rows = await db.txns.orderBy('date').reverse().toArray()

  if (!f.includeVoided) rows = rows.filter((t) => t.voided === 0)
  if (f.projectId) rows = rows.filter((t) => t.projectId === f.projectId)
  if (f.sourceId) rows = rows.filter((t) => t.sourceId === f.sourceId)
  if (f.payeeId) rows = rows.filter((t) => t.payeeId === f.payeeId)
  if (f.categoryId) rows = rows.filter((t) => t.categoryId === f.categoryId)
  if (f.from) rows = rows.filter((t) => t.date >= f.from!)
  if (f.to) rows = rows.filter((t) => t.date <= f.to!)

  if (f.search?.trim()) {
    const q = f.search.trim().toLowerCase()
    rows = rows.filter(
      (t) =>
        t.note?.toLowerCase().includes(q) ||
        t.refNo?.toLowerCase().includes(q),
    )
  }

  return rows
}

// --- helpers -------------------------------------------------------------

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

function nameMap<T extends { id: number; name: string }>(xs: T[]) {
  return new Map(xs.map((x) => [x.id, x.name]))
}

function groupSum(txns: Txn[], key: (t: Txn) => number | undefined): [number, Paise][] {
  const m = new Map<number, Paise>()
  for (const t of txns) {
    const k = key(t)
    if (k === undefined) continue
    m.set(k, (m.get(k) ?? 0) + t.amount)
  }
  return [...m.entries()]
}

function groupSumBy(txns: Txn[], key: (t: Txn) => string): [string, Paise][] {
  const m = new Map<string, Paise>()
  for (const t of txns) {
    const k = key(t)
    m.set(k, (m.get(k) ?? 0) + t.amount)
  }
  return [...m.entries()]
}

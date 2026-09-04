import type { Id } from './ids'
import {
  db,
  isExpenseLike,
  isSettlement,
  txnKind,
  type Payee,
  type Project,
  type Source,
  type Txn,
  type TxnKind,
} from './schema'
import type { Paise } from '../lib/money'
import { monthOf, type DateStr } from '../lib/date'

/** Only non-voided transactions count toward any total. */
const live = () => db.txns.where('voided').equals(0)

/**
 * The synthetic bucket that gathers `onbehalf` spend in a source breakdown.
 * Those rows have no real source, but dropping them would make the chart
 * understate total spend; a labelled line keeps the breakdown adding up.
 */
export const PAID_BY_OTHERS = 'Paid by others'
export const PAID_BY_OTHERS_ID = '__paid_by_others__' as Id

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
export async function sourceBalances(projectId?: Id): Promise<SourceBalance[]> {
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
      // Filtering by sourceId is already kind-correct: `onbehalf` rows carry no
      // source (the cash was the fronter's), so they never touch a balance,
      // while a `settlement` does carry the source it was repaid from.
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
  /** Cash that reached this payee: ordinary payments plus repayments to them. */
  total: Paise
  txnCount: number
  lastPaid?: DateStr
  byProject: { projectId: Id; total: Paise }[]
  /** Money this person has fronted on your behalf (`onbehalf` rows). */
  fronted: Paise
  /** Of that, how much you have already paid back (`settlement` rows). */
  repaid: Paise
  /** Still outstanding: `fronted − repaid`. Zero once fully settled. */
  owed: Paise
}

/**
 * Answers "how much has this person been paid, on which property, and what do
 * I still owe them for money they fronted".
 *
 * Cash paid to a payee (`total`) is ordinary `expense` payments plus
 * `settlement` repayments — both carry `payeeId`. What they fronted is the
 * `onbehalf` rows that name them as `fronterId`.
 */
export async function payeeTotals(projectId?: Id): Promise<PayeeTotal[]> {
  const [payees, txns] = await Promise.all([db.payees.toArray(), live().toArray()])
  const scoped = projectId ? txns.filter((t) => t.projectId === projectId) : txns

  return payees
    .map((payee) => {
      const mine = scoped.filter((t) => t.payeeId === payee.id)
      const byProject = groupSum(mine, (t) => t.projectId).map(([id, total]) => ({
        projectId: id,
        total,
      }))
      const fronted = sum(
        scoped.filter((t) => txnKind(t) === 'onbehalf' && t.fronterId === payee.id).map((t) => t.amount),
      )
      const repaid = sum(
        scoped.filter((t) => isSettlement(t) && t.payeeId === payee.id).map((t) => t.amount),
      )
      return {
        payee,
        total: sum(mine.map((t) => t.amount)),
        txnCount: mine.length,
        lastPaid: mine.length ? mine.reduce((a, t) => (t.date > a ? t.date : a), mine[0].date) : undefined,
        byProject: byProject.sort((a, b) => b.total - a.total),
        fronted,
        repaid,
        owed: fronted - repaid,
      }
    })
    .sort((a, b) => b.total - a.total)
}

export interface OwedTotal {
  payee: Payee
  owed: Paise
}

/**
 * Who you still owe for money they fronted, largest first. Only positive
 * balances — an over-repayment (owed < 0) is a data slip, not a debt to list.
 */
export async function owedByPayee(): Promise<OwedTotal[]> {
  return (await payeeTotals())
    .filter((t) => t.owed > 0)
    .map((t) => ({ payee: t.payee, owed: t.owed }))
    .sort((a, b) => b.owed - a.owed)
}

export interface ProjectSummary {
  project: Project
  spent: Paise
  txnCount: number
  byCategory: { id: Id; name: string; total: Paise }[]
  bySource: { id: Id; name: string; total: Paise }[]
  byPayeeRole: { role: string; total: Paise }[]
  byMonth: { month: string; total: Paise }[]
  firstDate?: DateStr
  lastDate?: DateStr
}

export async function projectSummary(projectId: Id): Promise<ProjectSummary | null> {
  const project = await db.projects.get(projectId)
  if (!project) return null

  const [allTxns, categories, sources, payees] = await Promise.all([
    db.txns.where('[projectId+voided]').equals([projectId, 0]).toArray(),
    db.categories.toArray(),
    db.sources.toArray(),
    db.payees.toArray(),
  ])

  // Settlements move cash to repay a fronter; the cost they settle was already
  // recognised by the `onbehalf` row, so they never count as a project's spend.
  const txns = allTxns.filter(isExpenseLike)

  const catName = nameMap(categories)
  const srcName = nameMap(sources)
  const roleOf = new Map(payees.map((p) => [p.id, p.role]))
  const dates = txns.map((t) => t.date).sort()

  // `onbehalf` rows have no source, so they would silently drop out of the
  // source breakdown; collect them under one honest "Paid by others" line.
  const fronted = sum(txns.filter((t) => txnKind(t) === 'onbehalf').map((t) => t.amount))
  const bySource = groupSum(txns, (t) => t.sourceId)
    .map(([id, total]) => ({ id, name: srcName.get(id) ?? 'Unknown', total }))
  if (fronted !== 0) bySource.push({ id: PAID_BY_OTHERS_ID, name: PAID_BY_OTHERS, total: fronted })

  return {
    project,
    spent: sum(txns.map((t) => t.amount)),
    txnCount: txns.length,
    byCategory: groupSum(txns, (t) => t.categoryId)
      .map(([id, total]) => ({ id, name: catName.get(id) ?? 'Uncategorised', total }))
      .sort((a, b) => b.total - a.total),
    bySource: bySource.sort((a, b) => b.total - a.total),
    byPayeeRole: groupSumBy(txns, (t) =>
      txnKind(t) === 'onbehalf'
        ? t.fronterId
          ? roleOf.get(t.fronterId) ?? 'other'
          : 'other'
        : t.payeeId
          ? roleOf.get(t.payeeId) ?? 'other'
          : 'unassigned',
    )
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
  projectId?: Id
  sourceId?: Id
  payeeId?: Id
  categoryId?: Id
  kind?: TxnKind
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
  // A payee filter matches whether they received the money or fronted it, so a
  // person's whole involvement stays together when scoped to them.
  if (f.payeeId) rows = rows.filter((t) => t.payeeId === f.payeeId || t.fronterId === f.payeeId)
  if (f.categoryId) rows = rows.filter((t) => t.categoryId === f.categoryId)
  if (f.kind) rows = rows.filter((t) => txnKind(t) === f.kind)
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

function nameMap<T extends { id: Id; name: string }>(xs: T[]) {
  return new Map(xs.map((x) => [x.id, x.name]))
}

function groupSum(txns: Txn[], key: (t: Txn) => Id | undefined): [Id, Paise][] {
  const m = new Map<Id, Paise>()
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

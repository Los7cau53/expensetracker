import type { Id } from '../db/ids'
import * as XLSX from 'xlsx'
import { db } from '../db/schema'
import { guessPayeeRole, guessSourceType } from './infer'
import { coerceToDateStr, type DateStr } from './date'
import { parseAmountToPaise, type Paise } from './money'

export type Cell = string | number | boolean | Date | null

export interface SheetData {
  name: string
  rows: Cell[][]
}

/** The importable fields. `date` and `amount` are the only required ones. */
export const IMPORT_FIELDS = [
  'date',
  'amount',
  'project',
  'payee',
  'category',
  'source',
  'note',
  'refNo',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** Column index per field, or null when that field is not in the sheet. */
export type Mapping = Record<ImportField, number | null>

export const EMPTY_MAPPING: Mapping = {
  date: null,
  amount: null,
  project: null,
  payee: null,
  category: null,
  source: null,
  note: null,
  refNo: null,
}

export async function readWorkbook(file: File): Promise<SheetData[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: true })
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    }),
  }))
}

/**
 * Finds the column-title row, and decides whether the sheet has one at all.
 *
 * The second part matters as much as the first: plenty of real sheets start
 * straight in on data, and mistaking row 1 for a header silently swallows a
 * payment. A header row is text-only — no dates, no amounts — so a row
 * carrying either is data.
 */
export function guessHeader(rows: Cell[][]): { headerRow: number; hasHeader: boolean } {
  const isDataRow = (row: Cell[]) =>
    row.some((c) => c !== null && (coerceToDateStr(c) !== null || parseAmountToPaise(c) !== null))

  const isTitleRow = (row: Cell[]) => {
    const cells = row.filter((c) => c !== null && String(c).trim() !== '')
    if (cells.length < 2) return false
    // Column titles are short text, and parse as neither a date nor money.
    return cells.every(
      (c) =>
        typeof c === 'string' &&
        c.trim().length < 40 &&
        coerceToDateStr(c) === null &&
        parseAmountToPaise(c) === null,
    )
  }

  const limit = Math.min(rows.length, 30)

  // The header is the title row that actually sits on top of the data. Letter
  // templates stack several title-ish rows ("Name", "Employee ID") above the
  // real one, so proximity to data is what distinguishes it.
  for (let i = 0; i < limit; i++) {
    if (!isTitleRow(rows[i])) continue
    const next = rows.slice(i + 1).find((r) => r.some((c) => c !== null && String(c).trim() !== ''))
    if (next && isDataRow(next)) return { headerRow: i, hasHeader: true }
  }

  return { headerRow: 0, hasHeader: false }
}

/** Kept for callers that only need the row index. */
export function guessHeaderRow(rows: Cell[][]): number {
  return guessHeader(rows).headerRow
}

const FIELD_HINTS: Record<ImportField, string[]> = {
  date: ['date', 'dt', 'day'],
  amount: ['amount', 'amt', 'paid', 'value', 'rupees', 'inr', 'cost', 'expense', 'debit', 'total'],
  project: ['project', 'property', 'site', 'plot', 'house', 'building'],
  payee: ['payee', 'paid to', 'to whom', 'whom', 'person', 'vendor', 'supplier', 'name', 'given to', 'mestri', 'worker', 'contractor'],
  category: ['category', 'head', 'purpose', 'for', 'particular', 'description', 'work', 'item', 'type'],
  source: ['source', 'from', 'paid from', 'account', 'mode', 'bank', 'payment mode', 'cash'],
  note: ['note', 'remark', 'comment', 'detail'],
  refNo: ['ref', 'reference', 'cheque', 'utr', 'txn', 'voucher', 'bill no', 'invoice'],
}

/** Pre-fills the mapping from the header titles, so the user only corrects it. */
export function guessMapping(headerCells: Cell[]): Mapping {
  const headers = headerCells.map((c) => String(c ?? '').trim().toLowerCase())
  const mapping: Mapping = { ...EMPTY_MAPPING }
  const taken = new Set<number>()

  // Exact-ish matches first, so "amount" wins over "total amount paid" for `amount`.
  for (const field of IMPORT_FIELDS) {
    const hints = FIELD_HINTS[field]
    let bestIndex = -1
    let bestScore = 0

    headers.forEach((h, i) => {
      if (!h || taken.has(i)) return
      for (const hint of hints) {
        const score = h === hint ? 3 : h.startsWith(hint) || h.endsWith(hint) ? 2 : h.includes(hint) ? 1 : 0
        if (score > bestScore) {
          bestScore = score
          bestIndex = i
        }
      }
    })

    if (bestIndex >= 0) {
      mapping[field] = bestIndex
      taken.add(bestIndex)
    }
  }

  return mapping
}

export interface ParsedRow {
  sheetRow: number
  date: DateStr
  amount: Paise
  project?: string
  payee?: string
  category?: string
  source?: string
  note?: string
  refNo?: string
}

export interface RejectedRow {
  sheetRow: number
  reason: string
  preview: string
}

export interface Analysis {
  valid: ParsedRow[]
  rejected: RejectedRow[]
  /** Net of any negative rows — reversals and refunds keep their sign. */
  total: Paise
  outflow: Paise
  inflow: Paise
  distinct: Record<'project' | 'payee' | 'category' | 'source', string[]>
}

export interface AnalyzeOptions {
  /** 03/04 means 3 April when true (the Indian convention). */
  dayFirst?: boolean
  /**
   * Many real sheets have no title row at all — the first row is data.
   * Treating it as a header would silently swallow a payment.
   */
  hasHeader?: boolean
  /**
   * Date to use for rows with no readable one. Sheets that track a single
   * job often omit the date entirely; without this every row is rejected.
   */
  fallbackDate?: DateStr
}

/**
 * Hand-kept sheets carry total and signature rows inline. They parse as
 * perfectly good payments and would double-count the sheet, so they are
 * rejected by name rather than by luck.
 */
const SUMMARY_ROW = /^\s*(grand\s+)?totals?\b|^\s*total\s+for\b|^\s*signature\s*$|^\s*sub\s*-?total/i

function looksLikeSummaryRow(row: Cell[]): boolean {
  return row.some((c) => typeof c === 'string' && SUMMARY_ROW.test(c))
}

const text = (c: Cell): string | undefined => {
  if (c === null || c === undefined) return undefined
  const s = String(c).trim()
  return s === '' ? undefined : s
}

/**
 * Dry run: parses every data row, keeping the good ones and explaining each
 * rejection. Nothing is written until the user has seen this.
 */
export function analyze(
  rows: Cell[][],
  headerRow: number,
  mapping: Mapping,
  opts: AnalyzeOptions = {},
): Analysis {
  const { dayFirst = true, hasHeader = true, fallbackDate } = opts
  const valid: ParsedRow[] = []
  const rejected: RejectedRow[] = []
  const distinct = {
    project: new Set<string>(),
    payee: new Set<string>(),
    category: new Set<string>(),
    source: new Set<string>(),
  }

  const at = (row: Cell[], field: ImportField): Cell => {
    const i = mapping[field]
    return i === null ? null : row[i] ?? null
  }

  const firstDataRow = hasHeader ? headerRow + 1 : 0
  for (let r = firstDataRow; r < rows.length; r++) {
    const row = rows[r]
    const sheetRow = r + 1 // 1-indexed, matching what Excel shows
    const preview = row
      .filter((c) => c !== null && String(c).trim() !== '')
      .slice(0, 4)
      .map((c) => String(c))
      .join(' · ')

    if (!preview) continue // genuinely blank row, not worth reporting

    if (looksLikeSummaryRow(row)) {
      rejected.push({ sheetRow, reason: 'Looks like a total or signature row', preview })
      continue
    }

    const amount = parseAmountToPaise(at(row, 'amount'))
    if (amount === null) {
      rejected.push({ sheetRow, reason: 'No readable amount', preview })
      continue
    }
    if (amount === 0) {
      rejected.push({ sheetRow, reason: 'Amount is zero', preview })
      continue
    }

    const date = coerceToDateStr(at(row, 'date'), dayFirst) ?? fallbackDate
    if (!date) {
      rejected.push({ sheetRow, reason: 'No readable date', preview })
      continue
    }

    const parsed: ParsedRow = {
      sheetRow,
      date,
      // Negatives are kept, not absolute-valued: a reversed online payment or
      // a refund must reduce the net spend, not add to it.
      amount,
      project: text(at(row, 'project')),
      payee: text(at(row, 'payee')),
      category: text(at(row, 'category')),
      source: text(at(row, 'source')),
      note: text(at(row, 'note')),
      refNo: text(at(row, 'refNo')),
    }

    if (parsed.project) distinct.project.add(parsed.project)
    if (parsed.payee) distinct.payee.add(parsed.payee)
    if (parsed.category) distinct.category.add(parsed.category)
    if (parsed.source) distinct.source.add(parsed.source)

    valid.push(parsed)
  }

  const collator = new Intl.Collator('en', { sensitivity: 'base' })
  return {
    valid,
    rejected,
    total: valid.reduce((a, p) => a + p.amount, 0),
    outflow: valid.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0),
    inflow: valid.filter((p) => p.amount < 0).reduce((a, p) => a - p.amount, 0),
    distinct: {
      project: [...distinct.project].sort(collator.compare),
      payee: [...distinct.payee].sort(collator.compare),
      category: [...distinct.category].sort(collator.compare),
      source: [...distinct.source].sort(collator.compare),
    },
  }
}

/**
 * Raw sheet value -> canonical name. Lets "Mesthri", "mestri" and "Mistri"
 * collapse onto one payee. An empty string means "leave unassigned".
 */
export type Aliases = Record<'project' | 'payee' | 'category' | 'source', Record<string, string>>

export function defaultAliases(distinct: Analysis['distinct']): Aliases {
  const build = (values: string[]) => {
    const out: Record<string, string> = {}
    // Case- and space-insensitive grouping picks one spelling as canonical,
    // which is the most common real-world duplicate in a hand-kept sheet.
    const canonical = new Map<string, string>()
    for (const v of values) {
      const key = v.toLowerCase().replace(/\s+/g, ' ').trim()
      if (!canonical.has(key)) canonical.set(key, v)
      out[v] = canonical.get(key)!
    }
    return out
  }
  return {
    project: build(distinct.project),
    payee: build(distinct.payee),
    category: build(distinct.category),
    source: build(distinct.source),
  }
}

export interface CommitOptions {
  fileName: string
  sheetName: string
  headerRow: number
  mapping: Mapping
  fallbackProjectId: Id
  fallbackSourceId: Id
  fallbackCategoryId: Id
  /**
   * Created if missing and used for rows with no category of their own.
   * In sheets organised one-tab-per-job, the tab name IS the cost head.
   */
  fallbackCategoryName?: string
}

export interface CommitResult {
  batchId: Id
  inserted: number
  created: Record<'projects' | 'payees' | 'categories' | 'sources', number>
  /** True when the rows were written as fund inflows rather than payments. */
  asFundIns: boolean
}

/**
 * Some tabs in a hand-kept workbook record money coming IN — a cash withdrawal
 * into the site float, a transfer from family, a loan tranche — not money
 * spent. Importing those as payments both inflates total spend and
 * double-counts, because the same money is spent again on the work tabs.
 */
export interface FundInOptions {
  asFundIns?: boolean
}

/**
 * Writes the analysed rows in a single transaction under one batch id, so the
 * whole import can be undone as a unit if the mapping turns out wrong.
 */
export async function commitImport(
  analysis: Analysis,
  aliases: Aliases,
  opts: CommitOptions & FundInOptions,
): Promise<CommitResult> {
  const created = { projects: 0, payees: 0, categories: 0, sources: 0 }

  return db.transaction(
    'rw',
    [db.projects, db.payees, db.categories, db.sources, db.txns, db.fundIns, db.importBatches],
    async () => {
      const batchId = (await db.importBatches.add({
        fileName: opts.fileName,
        sheetName: opts.sheetName,
        importedAt: Date.now(),
        rowCount: analysis.valid.length,
        mapping: JSON.stringify({ headerRow: opts.headerRow, mapping: opts.mapping }),
      } as never)) as string

      // Existing names are matched case-insensitively so an import does not
      // create a second "Cement traders" alongside the one already there.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
      const index = async <T extends { id: Id; name: string }>(rows: T[]) =>
        new Map(rows.map((r) => [norm(r.name), r.id]))

      const projectIds = await index(await db.projects.toArray())
      const payeeIds = await index(await db.payees.toArray())
      const categoryIds = await index(await db.categories.toArray())
      const sourceIds = await index(await db.sources.toArray())

      let categorySort = (await db.categories.count()) + 1000

      let fallbackCategoryId = opts.fallbackCategoryId
      if (opts.fallbackCategoryName?.trim()) {
        const wanted = opts.fallbackCategoryName.trim()
        const hit = categoryIds.get(norm(wanted))
        if (hit) {
          fallbackCategoryId = hit
        } else {
          fallbackCategoryId = (await db.categories.add({
            name: wanted,
            sortOrder: categorySort++,
          } as never)) as string
          categoryIds.set(norm(wanted), fallbackCategoryId)
          created.categories++
        }
      }

      const resolveProject = async (raw?: string) => {
        const name = raw ? aliases.project[raw] ?? raw : ''
        if (!name) return opts.fallbackProjectId
        const hit = projectIds.get(norm(name))
        if (hit) return hit
        const id = (await db.projects.add({
          name,
          status: 'active',
          createdAt: Date.now(),
        } as never)) as string
        projectIds.set(norm(name), id)
        created.projects++
        return id
      }

      const resolvePayee = async (raw?: string) => {
        const name = raw ? aliases.payee[raw] ?? raw : ''
        if (!name) return undefined
        const hit = payeeIds.get(norm(name))
        if (hit) return hit
        const id = (await db.payees.add({
          name,
          role: guessPayeeRole(name),
          archived: 0,
          createdAt: Date.now(),
        } as never)) as string
        payeeIds.set(norm(name), id)
        created.payees++
        return id
      }

      const resolveCategory = async (raw?: string) => {
        const name = raw ? aliases.category[raw] ?? raw : ''
        if (!name) return fallbackCategoryId
        const hit = categoryIds.get(norm(name))
        if (hit) return hit
        const id = (await db.categories.add({
          name,
          sortOrder: categorySort++,
        } as never)) as string
        categoryIds.set(norm(name), id)
        created.categories++
        return id
      }

      const resolveSource = async (raw?: string) => {
        const name = raw ? aliases.source[raw] ?? raw : ''
        if (!name) return opts.fallbackSourceId
        const hit = sourceIds.get(norm(name))
        if (hit) return hit
        const id = (await db.sources.add({
          name,
          type: guessSourceType(name),
          openingBalance: 0,
          archived: 0,
          createdAt: Date.now(),
        } as never)) as string
        sourceIds.set(norm(name), id)
        created.sources++
        return id
      }

      const now = Date.now()

      if (opts.asFundIns) {
        const fundIns = []
        for (const row of analysis.valid) {
          fundIns.push({
            date: row.date,
            // An inflow is always positive; a negative row on a funding tab
            // is money leaving again, which belongs on a spending tab.
            amount: Math.abs(row.amount),
            sourceId: await resolveSource(row.source),
            // Whatever the sheet called it is the best description of where
            // the money came from.
            origin: row.category ?? row.payee ?? row.note ?? 'Funds in',
            projectId: row.project ? await resolveProject(row.project) : undefined,
            note: row.note,
            importBatchId: batchId,
            createdAt: now,
          })
        }
        await db.fundIns.bulkAdd(fundIns as never)
        return { batchId, inserted: fundIns.length, created, asFundIns: true }
      }

      const txns = []
      for (const row of analysis.valid) {
        txns.push({
          date: row.date,
          amount: row.amount,
          projectId: await resolveProject(row.project),
          payeeId: await resolvePayee(row.payee),
          categoryId: await resolveCategory(row.category),
          sourceId: await resolveSource(row.source),
          note: row.note,
          refNo: row.refNo,
          importBatchId: batchId,
          voided: 0 as const,
          createdAt: now,
          updatedAt: now,
        })
      }
      await db.txns.bulkAdd(txns as never)

      return { batchId, inserted: txns.length, created, asFundIns: false }
    },
  )
}

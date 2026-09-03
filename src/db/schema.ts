import Dexie, { type EntityTable } from 'dexie'
import { newId, type Id } from './ids'
import type { DateStr } from '../lib/date'
import type { Paise } from '../lib/money'

export const SOURCE_TYPES = ['bank', 'cash', 'upi', 'card', 'loan'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const PAYEE_ROLES = [
  'mestri',
  'labour',
  'electrician',
  'plumber',
  'carpenter',
  'painter',
  'material',
  'machinery',
  'govt',
  'professional',
  'other',
] as const
export type PayeeRole = (typeof PAYEE_ROLES)[number]

export const PROJECT_STATUSES = ['active', 'onhold', 'done'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/** IndexedDB cannot index booleans, so flags are stored as 0 | 1. */
export type Flag = 0 | 1

export interface Project {
  id: Id
  name: string
  address?: string
  status: ProjectStatus
  budget?: Paise
  createdAt: number
  updatedAt?: number
}

/** Where money comes FROM: a bank account, cash in hand, a UPI app, a loan. */
export interface Source {
  id: Id
  name: string
  type: SourceType
  institution?: string
  openingBalance: Paise
  archived: Flag
  notes?: string
  createdAt: number
  updatedAt?: number
}

/** Whom money is given TO: mestri, electrician, supplier, government office. */
export interface Payee {
  id: Id
  name: string
  role: PayeeRole
  phone?: string
  archived: Flag
  notes?: string
  createdAt: number
  updatedAt?: number
}

export interface Category {
  id: Id
  name: string
  sortOrder: number
  /** Archived cost heads stay on old entries but leave the picker. */
  archived?: Flag
  createdAt?: number
  updatedAt?: number
}

/**
 * One payment out. Never hard-deleted once it has been reconciled — a
 * correction sets voided=1 so the history survives a dispute with a contractor.
 */
export interface Txn {
  id: Id
  date: DateStr
  projectId: Id
  amount: Paise
  sourceId: Id
  payeeId?: Id
  categoryId: Id
  note?: string
  refNo?: string
  importBatchId?: Id
  voided: Flag
  voidedAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * Money INTO a source: a loan disbursement, a salary transfer, own capital.
 * Without these a source has no meaningful balance, only a running outflow.
 */
export interface FundIn {
  id: Id
  date: DateStr
  sourceId: Id
  amount: Paise
  origin: string
  projectId?: Id
  note?: string
  /** Set when the row came from a spreadsheet import, so it can be undone. */
  importBatchId?: Id
  createdAt: number
  updatedAt?: number
}

export interface ImportBatch {
  id: Id
  fileName: string
  sheetName: string
  importedAt: number
  rowCount: number
  /** JSON-serialised column mapping, so the next import can be pre-filled. */
  mapping: string
}

export interface Setting {
  key: string
  value: unknown
}

/**
 * A record of a deletion, so sync can propagate it.
 *
 * A hard delete leaves nothing behind, so the other device would push its own
 * still-present copy back and the record would silently reappear.
 */
export interface Tombstone {
  /** `<table>:<recordId>` */
  id: string
  table: SyncedTable
  recordId: Id
  deletedAt: number
}

export const SYNCED_TABLES = [
  'projects',
  'sources',
  'payees',
  'categories',
  'txns',
  'fundIns',
] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export const DB_NAME = 'constructionLedger'
/** The pre-UUID database. Read once during migration, then left alone. */
export const LEGACY_DB_NAME = 'constructionExpenses'

const db = new Dexie(DB_NAME) as Dexie & {
  projects: EntityTable<Project, 'id'>
  sources: EntityTable<Source, 'id'>
  payees: EntityTable<Payee, 'id'>
  categories: EntityTable<Category, 'id'>
  txns: EntityTable<Txn, 'id'>
  fundIns: EntityTable<FundIn, 'id'>
  importBatches: EntityTable<ImportBatch, 'id'>
  settings: EntityTable<Setting, 'key'>
  tombstones: EntityTable<Tombstone, 'id'>
}

db.version(1).stores({
  projects: 'id, name, status',
  sources: 'id, name, type, archived',
  payees: 'id, name, role, archived',
  categories: 'id, name, sortOrder, archived',
  txns:
    'id, date, projectId, sourceId, payeeId, categoryId, voided, importBatchId, ' +
    '[projectId+date], [sourceId+voided], [payeeId+voided], [projectId+voided]',
  fundIns: 'id, date, sourceId, projectId, importBatchId, [sourceId+date]',
  importBatches: 'id, importedAt',
  settings: 'key',
  tombstones: 'id, table, deletedAt',
})

/**
 * Ids are assigned here rather than at each `add()` call site.
 *
 * With `++id` gone, every insert must supply a primary key. Doing that in ~20
 * call sites means one will eventually be missed, and the failure — a record
 * written with `id: undefined` — is both silent and corrupting. A creating
 * hook makes it impossible to forget.
 */
for (const table of [
  db.projects,
  db.sources,
  db.payees,
  db.categories,
  db.txns,
  db.fundIns,
  db.importBatches,
]) {
  table.hook('creating', (_primKey, obj: { id?: Id; createdAt?: number; updatedAt?: number }) => {
    if (!obj.id) obj.id = newId()
    const now = Date.now()
    if (obj.createdAt === undefined) obj.createdAt = now
    // The stamp sync compares against. Every write must move it.
    if (obj.updatedAt === undefined) obj.updatedAt = now
    return obj.id
  })

  table.hook('updating', (modifications) => {
    // Sync itself writes an explicit updatedAt when applying a remote record;
    // overwriting it here would make the local copy look newer and push back.
    if (modifications && typeof modifications === 'object' && 'updatedAt' in modifications) {
      return undefined
    }
    return { updatedAt: Date.now() }
  })
}

export { db }

export const DEFAULT_CATEGORIES = [
  'Land & registration',
  'Permissions & approvals',
  'Design & consulting',
  'Excavation & foundation',
  'Structure & RCC',
  'Masonry',
  'Plastering',
  'Electrical',
  'Plumbing & sanitary',
  'Doors & windows',
  'Flooring & tiling',
  'Painting',
  'Carpentry & interiors',
  'Roofing & waterproofing',
  'Compound & external',
  'Material - cement',
  'Material - steel',
  'Material - sand & aggregate',
  'Material - bricks & blocks',
  'Machinery & rental',
  'Transport',
  'Labour - general',
  'Utilities & connections',
  'Miscellaneous',
]

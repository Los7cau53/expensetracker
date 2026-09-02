import Dexie, { type EntityTable } from 'dexie'
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
  id: number
  name: string
  address?: string
  status: ProjectStatus
  budget?: Paise
  createdAt: number
}

/** Where money comes FROM: a bank account, cash in hand, a UPI app, a loan. */
export interface Source {
  id: number
  name: string
  type: SourceType
  institution?: string
  openingBalance: Paise
  archived: Flag
  notes?: string
  createdAt: number
}

/** Whom money is given TO: mestri, electrician, supplier, government office. */
export interface Payee {
  id: number
  name: string
  role: PayeeRole
  phone?: string
  archived: Flag
  notes?: string
  createdAt: number
}

export interface Category {
  id: number
  name: string
  sortOrder: number
}

/**
 * One payment out. Never hard-deleted once it has been reconciled — a
 * correction sets voided=1 so the history survives a dispute with a contractor.
 */
export interface Txn {
  id: number
  date: DateStr
  projectId: number
  amount: Paise
  sourceId: number
  payeeId?: number
  categoryId: number
  note?: string
  refNo?: string
  importBatchId?: number
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
  id: number
  date: DateStr
  sourceId: number
  amount: Paise
  origin: string
  projectId?: number
  note?: string
  /** Set when the row came from a spreadsheet import, so it can be undone. */
  importBatchId?: number
  createdAt: number
}

export interface ImportBatch {
  id: number
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

const db = new Dexie('constructionExpenses') as Dexie & {
  projects: EntityTable<Project, 'id'>
  sources: EntityTable<Source, 'id'>
  payees: EntityTable<Payee, 'id'>
  categories: EntityTable<Category, 'id'>
  txns: EntityTable<Txn, 'id'>
  fundIns: EntityTable<FundIn, 'id'>
  importBatches: EntityTable<ImportBatch, 'id'>
  settings: EntityTable<Setting, 'key'>
}

db.version(1).stores({
  projects: '++id, name, status',
  sources: '++id, name, type, archived',
  payees: '++id, name, role, archived',
  categories: '++id, name, sortOrder',
  txns:
    '++id, date, projectId, sourceId, payeeId, categoryId, voided, importBatchId, ' +
    '[projectId+date], [sourceId+voided], [payeeId+voided], [projectId+voided]',
  fundIns: '++id, date, sourceId, projectId, [sourceId+date]',
  importBatches: '++id, importedAt',
  settings: 'key',
})

// v2: fund inflows can now come from a spreadsheet import, so they need to be
// undoable as a batch like transactions are.
db.version(2).stores({
  fundIns: '++id, date, sourceId, projectId, importBatchId, [sourceId+date]',
})

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

import type { Id } from '../db/ids'
import type { SyncedTable } from '../db/schema'

/** One record as it travels to and from the remote store. */
export interface RemoteRecord {
  table: SyncedTable
  id: Id
  /** The record's own change stamp — what conflicts are resolved by. */
  updatedAt: number
  /** A deletion carries no body. */
  deleted?: boolean
  data?: Record<string, unknown>
}

/**
 * The remote half of sync, kept behind an interface so the merge rules can be
 * tested exhaustively against an in-memory store. The Firestore implementation
 * is deliberately thin.
 */
export interface RemoteStore {
  /** Everything changed strictly after `since`, oldest first. */
  pull(since: number): Promise<RemoteRecord[]>
  push(records: RemoteRecord[]): Promise<void>
}

export interface SyncResult {
  pushed: number
  pulled: number
  /** Remote records that were newer and were written locally. */
  applied: number
  /** Remote records ignored because the local copy was newer. */
  skippedStale: number
  deletedLocally: number
  ranAt: number
}

export const EMPTY_RESULT: SyncResult = {
  pushed: 0,
  pulled: 0,
  applied: 0,
  skippedStale: 0,
  deletedLocally: 0,
  ranAt: 0,
}

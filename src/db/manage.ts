import { db, type Source, type SourceType } from './schema'
import type { Paise } from '../lib/money'

export interface SourceUsage {
  txnCount: number
  fundInCount: number
  /** True when deleting would orphan rows, so merge or archive is the answer. */
  inUse: boolean
}

export async function sourceUsage(sourceId: number): Promise<SourceUsage> {
  const [txnCount, fundInCount] = await Promise.all([
    db.txns.where('sourceId').equals(sourceId).count(),
    db.fundIns.where('sourceId').equals(sourceId).count(),
  ])
  return { txnCount, fundInCount, inUse: txnCount + fundInCount > 0 }
}

export interface SourceEdits {
  name: string
  type: SourceType
  institution?: string
  openingBalance: Paise
  notes?: string
}

export async function updateSource(sourceId: number, edits: SourceEdits): Promise<void> {
  const name = edits.name.trim()
  if (!name) throw new Error('A source needs a name.')

  const norm = (v: string) => v.trim().toLowerCase()
  const current = await db.sources.get(sourceId)
  if (!current) throw new Error('That source no longer exists.')

  // Only guard against a *new* collision. An import can leave two spellings of
  // one account ("sbi 4471" and "SBI 4471"); checking unconditionally would
  // then block fixing either one's type until it was also renamed.
  if (norm(name) !== norm(current.name)) {
    const clash = (await db.sources.toArray()).find(
      (s) => s.id !== sourceId && norm(s.name) === norm(name),
    )
    if (clash) throw new Error(`"${clash.name}" already exists. Merge into it instead.`)
  }

  await db.sources.update(sourceId, {
    name,
    type: edits.type,
    institution: edits.institution?.trim() || undefined,
    openingBalance: edits.openingBalance,
    notes: edits.notes?.trim() || undefined,
  })
}

/**
 * Archiving hides a source from the Add screen's picker but leaves every
 * historical row pointing at it, so past reports stay intact. This is the
 * right move for an account you have stopped using.
 */
export async function setSourceArchived(sourceId: number, archived: boolean): Promise<void> {
  await db.sources.update(sourceId, { archived: archived ? 1 : 0 })
}

/**
 * Deletes a source outright. Refuses while anything still points at it —
 * a dangling sourceId would leave payments that belong to no account and
 * quietly break every balance.
 */
export async function deleteSource(sourceId: number): Promise<void> {
  const usage = await sourceUsage(sourceId)
  if (usage.inUse) {
    throw new Error(
      `${usage.txnCount} payments and ${usage.fundInCount} inflows still use this source. ` +
        'Merge it into another source, or archive it instead.',
    )
  }
  if ((await db.sources.count()) <= 1) {
    throw new Error('This is your only source. Add another before deleting this one.')
  }
  await db.sources.delete(sourceId)
}

export interface MergeResult {
  movedTxns: number
  movedFundIns: number
  openingBalanceAdded: Paise
}

/**
 * Moves everything from one source onto another and deletes the empty one.
 *
 * The importer matches sources by name, so a sheet spelling an account two
 * ways ("sbi 4471" and "SBI 4471") produces two entries for one real account.
 * Opening balances are added together, so the merged source's balance equals
 * the sum of the two it replaces.
 */
export async function mergeSources(fromId: number, intoId: number): Promise<MergeResult> {
  if (fromId === intoId) throw new Error('Pick a different source to merge into.')

  return db.transaction('rw', [db.sources, db.txns, db.fundIns], async () => {
    const from = await db.sources.get(fromId)
    const into = await db.sources.get(intoId)
    if (!from || !into) throw new Error('One of those sources no longer exists.')

    const movedTxns = await db.txns.where('sourceId').equals(fromId).modify({ sourceId: intoId })
    const movedFundIns = await db.fundIns
      .where('sourceId')
      .equals(fromId)
      .modify({ sourceId: intoId })

    await db.sources.update(intoId, {
      openingBalance: into.openingBalance + from.openingBalance,
    })
    await db.sources.delete(fromId)

    return { movedTxns, movedFundIns, openingBalanceAdded: from.openingBalance }
  })
}

/** Sources a given one may be merged into. */
export async function mergeTargets(sourceId: number): Promise<Source[]> {
  return (await db.sources.toArray())
    .filter((s) => s.id !== sourceId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

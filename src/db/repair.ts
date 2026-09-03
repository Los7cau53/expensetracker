import { db, SYNCED_TABLES, type SyncedTable } from './schema'
import type { Id } from './ids'
import { mergeCategories, mergePayees, mergeProjects, mergeSources } from './manage'

/** Tables where two records sharing a name means the same real thing twice. */
const NAMED_TABLES = ['projects', 'sources', 'payees', 'categories'] as const
export type NamedTable = (typeof NAMED_TABLES)[number]

export interface DuplicateGroup {
  table: NamedTable
  name: string
  /** The record everything else folds into. */
  keepId: Id
  mergeIds: Id[]
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  totalExtra: number
}

async function rows(table: NamedTable) {
  return (await db[table].toArray()) as { id: Id; name: string; createdAt?: number }[]
}

/**
 * Finds records that name the same thing twice.
 *
 * These arise from sync when two devices independently created what is really
 * one record — the seeded defaults did exactly that when the migration and the
 * seed disagreed about what id a default should have.
 *
 * The survivor is chosen deterministically so that every device, running this
 * independently, folds the same direction: a derived `seed-` id first (both
 * devices agree on it), then the oldest, then the lowest id.
 */
export async function findDuplicates(): Promise<DuplicateReport> {
  const groups: DuplicateGroup[] = []

  for (const table of NAMED_TABLES) {
    const byName = new Map<string, { id: Id; name: string; createdAt?: number }[]>()
    for (const r of await rows(table)) {
      const key = r.name.trim().toLowerCase().replace(/\s+/g, ' ')
      const list = byName.get(key) ?? []
      list.push(r)
      byName.set(key, list)
    }

    for (const list of byName.values()) {
      if (list.length < 2) continue
      const ranked = [...list].sort((a, b) => {
        const aSeed = a.id.startsWith('seed-') ? 0 : 1
        const bSeed = b.id.startsWith('seed-') ? 0 : 1
        return aSeed - bSeed || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)
      })
      groups.push({
        table,
        name: ranked[0].name,
        keepId: ranked[0].id,
        mergeIds: ranked.slice(1).map((r) => r.id),
      })
    }
  }

  return { groups, totalExtra: groups.reduce((n, g) => n + g.mergeIds.length, 0) }
}

export interface RepairResult {
  merged: number
  movedEntries: number
}

/**
 * Folds duplicates together, reusing the same merge functions the UI uses so
 * foreign keys are reassigned and tombstones written exactly as they would be
 * by hand. Nothing is deleted without its entries being moved first.
 */
export async function mergeDuplicates(): Promise<RepairResult> {
  const { groups } = await findDuplicates()
  let merged = 0
  let movedEntries = 0

  for (const g of groups) {
    for (const from of g.mergeIds) {
      const r: { movedTxns: number; movedFundIns?: number } =
        g.table === 'sources'
          ? await mergeSources(from, g.keepId)
          : g.table === 'payees'
            ? await mergePayees(from, g.keepId)
            : g.table === 'categories'
              ? await mergeCategories(from, g.keepId)
              : await mergeProjects(from, g.keepId)
      merged++
      movedEntries += r.movedTxns + (r.movedFundIns ?? 0)
    }
  }

  return { merged, movedEntries }
}

export interface ResetOptions {
  /** Also delete the copy held in the signed-in Google account. */
  includeRemote?: boolean
  /** Also delete the pre-UUID database kept as a migration fallback. */
  includeLegacy?: boolean
}

export interface ResetResult {
  localCleared: number
  remoteDeleted: number
  legacyDeleted: boolean
}

/**
 * Erases everything and starts over.
 *
 * The remote copy has to go too, or the next sync simply pulls it all back and
 * the reset looks like it silently failed. Sync cursors and the migration
 * marker are cleared as well, so a later legacy migration can run again rather
 * than believing it already did.
 */
export async function hardReset(
  opts: ResetOptions,
  wipeRemote?: () => Promise<number>,
): Promise<ResetResult> {
  let remoteDeleted = 0
  // Remote first: if it fails, nothing local has been lost yet.
  if (opts.includeRemote && wipeRemote) remoteDeleted = await wipeRemote()

  const counts = await Promise.all(SYNCED_TABLES.map((t) => db[t].count()))
  const localCleared = counts.reduce((a, b) => a + b, 0)

  await db.transaction(
    'rw',
    [
      db.projects, db.sources, db.payees, db.categories, db.txns, db.fundIns,
      db.importBatches, db.tombstones, db.settings,
    ],
    async () => {
      for (const t of SYNCED_TABLES) await db[t].clear()
      await db.importBatches.clear()
      // No tombstones: there is no one left to tell, and keeping them would
      // push deletions at a device that may hold the only remaining copy.
      await db.tombstones.clear()
      await db.settings.clear()
    },
  )

  let legacyDeleted = false
  if (opts.includeLegacy) {
    const Dexie = (await import('dexie')).default
    const { LEGACY_DB_NAME } = await import('./schema')
    if (await Dexie.exists(LEGACY_DB_NAME)) {
      await Dexie.delete(LEGACY_DB_NAME)
      legacyDeleted = true
    }
  }

  return { localCleared, remoteDeleted, legacyDeleted }
}

/** Named export for the settings screen's summary line. */
export async function localRecordCount(): Promise<Record<SyncedTable, number>> {
  const entries = await Promise.all(
    SYNCED_TABLES.map(async (t) => [t, await db[t].count()] as const),
  )
  return Object.fromEntries(entries) as Record<SyncedTable, number>
}

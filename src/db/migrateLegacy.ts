import Dexie from 'dexie'
import { db, LEGACY_DB_NAME } from './schema'
import { newId, type Id } from './ids'

/**
 * Moves data out of the pre-UUID database.
 *
 * Record ids changed from Dexie's per-device `++id` counter to UUIDs, which
 * IndexedDB cannot do in place — a store's primary key is fixed once created.
 * So the app opens a new database and copies the old one across, remapping
 * every foreign key as it goes.
 *
 * The legacy database is **never deleted**. If anything here is wrong, the
 * original rows are still sitting there untouched, and this is someone's
 * financial history.
 */

const DONE_KEY = 'legacyMigratedAt'

export interface MigrationReport {
  ran: boolean
  reason?: string
  counts: Record<string, number>
  /** Compared before and after; a mismatch means the migration is not trusted. */
  spentBefore: number
  spentAfter: number
}

const TABLES = [
  'projects',
  'sources',
  'payees',
  'categories',
  'txns',
  'fundIns',
  'importBatches',
] as const

export async function migrateLegacyIfNeeded(): Promise<MigrationReport> {
  const empty: MigrationReport = { ran: false, counts: {}, spentBefore: 0, spentAfter: 0 }

  if (await db.settings.get(DONE_KEY)) return { ...empty, reason: 'already migrated' }
  // Never overwrite a database that is already in use.
  if ((await db.txns.count()) > 0) return { ...empty, reason: 'new database already has entries' }
  if (!(await Dexie.exists(LEGACY_DB_NAME))) return { ...empty, reason: 'no legacy database' }

  // Opened without a declared schema: Dexie reads whatever stores exist, so
  // this keeps working regardless of which legacy version the device is on.
  const legacy = new Dexie(LEGACY_DB_NAME)
  await legacy.open()

  try {
    const present = new Set(legacy.tables.map((t) => t.name))
    const rows: Record<string, Record<string, unknown>[]> = {}
    for (const t of TABLES) {
      rows[t] = present.has(t) ? ((await legacy.table(t).toArray()) as Record<string, unknown>[]) : []
    }

    if (rows.txns.length === 0 && rows.sources.length <= 1 && rows.projects.length <= 1) {
      await db.settings.put({ key: DONE_KEY, value: Date.now() })
      return { ...empty, reason: 'legacy database held nothing worth moving' }
    }

    const spentBefore = rows.txns
      .filter((t) => !t.voided)
      .reduce((a, t) => a + Number(t.amount ?? 0), 0)

    // One new id per old id, per table.
    const map: Record<string, Map<unknown, Id>> = {}
    for (const t of TABLES) {
      map[t] = new Map(rows[t].map((r) => [r.id, newId()]))
    }

    const remap = (table: (typeof TABLES)[number], oldId: unknown): Id | undefined =>
      oldId === undefined || oldId === null ? undefined : map[table].get(oldId)

    const settings = present.has('settings')
      ? ((await legacy.table('settings').toArray()) as { key: string; value: unknown }[])
      : []

    await db.transaction(
      'rw',
      [db.projects, db.sources, db.payees, db.categories, db.txns, db.fundIns, db.importBatches, db.settings],
      async () => {
        await db.projects.bulkAdd(
          rows.projects.map((r) => ({ ...r, id: map.projects.get(r.id)! })) as never,
        )
        await db.sources.bulkAdd(
          rows.sources.map((r) => ({ ...r, id: map.sources.get(r.id)! })) as never,
        )
        await db.payees.bulkAdd(
          rows.payees.map((r) => ({ ...r, id: map.payees.get(r.id)! })) as never,
        )
        await db.categories.bulkAdd(
          rows.categories.map((r) => ({
            ...r,
            id: map.categories.get(r.id)!,
            archived: r.archived ?? 0,
          })) as never,
        )
        await db.importBatches.bulkAdd(
          rows.importBatches.map((r) => ({ ...r, id: map.importBatches.get(r.id)! })) as never,
        )

        await db.txns.bulkAdd(
          rows.txns.map((r) => ({
            ...r,
            id: map.txns.get(r.id)!,
            projectId: remap('projects', r.projectId),
            sourceId: remap('sources', r.sourceId),
            payeeId: remap('payees', r.payeeId),
            categoryId: remap('categories', r.categoryId),
            importBatchId: remap('importBatches', r.importBatchId),
          })) as never,
        )

        await db.fundIns.bulkAdd(
          rows.fundIns.map((r) => ({
            ...r,
            id: map.fundIns.get(r.id)!,
            sourceId: remap('sources', r.sourceId),
            projectId: remap('projects', r.projectId),
            importBatchId: remap('importBatches', r.importBatchId),
          })) as never,
        )

        // Carried across so the backup nag does not reset to "never".
        for (const s of settings) {
          if (s.key === 'backupFileHandle') continue
          await db.settings.put(s)
        }
        await db.settings.put({ key: DONE_KEY, value: Date.now() })
      },
    )

    const after = await db.txns.toArray()
    const spentAfter = after.filter((t) => !t.voided).reduce((a, t) => a + t.amount, 0)

    return {
      ran: true,
      counts: Object.fromEntries(TABLES.map((t) => [t, rows[t].length])),
      spentBefore,
      spentAfter,
    }
  } finally {
    legacy.close()
  }
}

/** Whether an unmigrated legacy database is sitting there. */
export async function legacyDatabaseExists(): Promise<boolean> {
  return Dexie.exists(LEGACY_DB_NAME)
}

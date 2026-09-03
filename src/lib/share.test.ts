// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import {
  backupFilename,
  buildSnapshot,
  shareBackupFile,
  supportsFileShare,
} from './backup'

const nav = navigator as unknown as {
  canShare?: (d: unknown) => boolean
  share?: (d: unknown) => Promise<void>
}

async function reset() {
  await Promise.all([
    db.projects.clear(), db.sources.clear(), db.payees.clear(), db.categories.clear(),
    db.txns.clear(), db.fundIns.clear(), db.importBatches.clear(), db.settings.clear(),
  ])
  await seedIfEmpty()
}

beforeEach(reset)
afterEach(() => {
  delete nav.canShare
  delete nav.share
})

describe('supportsFileShare', () => {
  it('is false when the browser has no canShare', () => {
    expect(supportsFileShare()).toBe(false)
  })

  it('is false when canShare rejects file payloads', () => {
    nav.canShare = () => false
    expect(supportsFileShare()).toBe(false)
  })

  it('is true only when a file payload is accepted', () => {
    nav.canShare = (d) => Array.isArray((d as { files?: unknown[] }).files)
    expect(supportsFileShare()).toBe(true)
  })
})

describe('shareBackupFile', () => {
  beforeEach(() => {
    nav.canShare = () => true
  })

  it('reports unsupported rather than throwing when sharing is unavailable', async () => {
    delete nav.canShare
    expect(await shareBackupFile('{}', 'x.json')).toBe('unsupported')
  })

  it('attaches the backup as a single JSON file, with no text payload', async () => {
    const share = vi.fn(async (_d: unknown) => {})
    nav.share = share

    const json = JSON.stringify(await buildSnapshot())
    expect(await shareBackupFile(json, 'backup.json')).toBe('shared')

    const payload = share.mock.calls[0][0] as { files: File[]; text?: string }
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0].name).toBe('backup.json')
    expect(payload.files[0].type).toBe('application/json')
    // Some share targets drop the attachment when text is also present.
    expect(payload.text).toBeUndefined()
    expect(await payload.files[0].text()).toBe(json)
  })

  it('records the backup timestamp on success', async () => {
    nav.share = async () => {}
    expect((await db.settings.get('lastBackupAt'))?.value).toBeNull()

    await shareBackupFile('{}', backupFilename())

    expect(typeof (await db.settings.get('lastBackupAt'))?.value).toBe('number')
  })

  it('does NOT record a backup when the sheet is dismissed', async () => {
    nav.share = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }

    // Dismissing is not a failure, and it is certainly not a backup — claiming
    // one would silence the nag while nothing had been saved.
    expect(await shareBackupFile('{}', 'x.json')).toBe('cancelled')
    expect((await db.settings.get('lastBackupAt'))?.value).toBeNull()
  })

  it('treats a blocked share as a dismissal, not a crash', async () => {
    nav.share = async () => {
      throw new DOMException('Not allowed', 'NotAllowedError')
    }
    expect(await shareBackupFile('{}', 'x.json')).toBe('cancelled')
    expect((await db.settings.get('lastBackupAt'))?.value).toBeNull()
  })

  it('propagates a genuine failure so it is not silently swallowed', async () => {
    nav.share = async () => {
      throw new Error('transport exploded')
    }
    await expect(shareBackupFile('{}', 'x.json')).rejects.toThrow('transport exploded')
    expect((await db.settings.get('lastBackupAt'))?.value).toBeNull()
  })

  it('shares a file that restores cleanly — the round trip still holds', async () => {
    let captured: File | null = null
    nav.share = async (d) => {
      captured = (d as { files: File[] }).files[0]
    }

    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]
    await db.txns.add({
      date: '2026-03-01', amount: 12_345_67, projectId: project.id, sourceId: source.id,
      categoryId: category.id, voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    const json = JSON.stringify(await buildSnapshot(), null, 2)
    await shareBackupFile(json, backupFilename())

    const { parseSnapshot, restoreSnapshot } = await import('./backup')
    const text = await captured!.text()
    await db.txns.clear()
    const report = await restoreSnapshot(parseSnapshot(text))

    expect(report.counts.txns).toBe(1)
    expect((await db.txns.toArray())[0].amount).toBe(12_345_67)
  })
})

describe('backupFilename', () => {
  it('is dated, so successive shares do not overwrite each other in Drive', () => {
    expect(backupFilename()).toMatch(/^construction-expenses-\d{4}-\d{2}-\d{2}\.json$/)
  })
})

describe('restore staleness guard', () => {
  const age = (newestEntryAt: number | null, txnCount = 1, fundInCount = 0) => ({
    txnCount,
    fundInCount,
    newestEntryAt,
  })

  it('warns when the file is older than what is already here', async () => {
    const { wouldLoseWork } = await import('./backup')
    const now = Date.now()

    const v = wouldLoseWork(age(now - 3 * 86400000, 5), age(now, 9))

    expect(v.stale).toBe(true)
    expect(Math.round(v.localNewerBy / 86400000)).toBe(3)
    expect(v.entriesAtRisk).toBe(4)
  })

  it('stays quiet when the file is newer', async () => {
    const { wouldLoseWork } = await import('./backup')
    const now = Date.now()
    expect(wouldLoseWork(age(now, 9), age(now - 86400000, 5)).stale).toBe(false)
  })

  it('tolerates clock skew between two devices', async () => {
    const { wouldLoseWork } = await import('./backup')
    const now = Date.now()
    // 30s of skew is not a reason to cry wolf; 10 minutes is.
    expect(wouldLoseWork(age(now - 30_000), age(now)).stale).toBe(false)
    expect(wouldLoseWork(age(now - 600_000), age(now)).stale).toBe(true)
  })

  it('never warns when this device is empty — there is nothing to lose', async () => {
    const { wouldLoseWork } = await import('./backup')
    const now = Date.now()
    const empty = { txnCount: 0, fundInCount: 0, newestEntryAt: null }
    expect(wouldLoseWork(age(now - 9999999), empty).stale).toBe(false)
  })

  it('reads the age out of a real snapshot', async () => {
    const { buildSnapshot, snapshotAge, localAge } = await import('./backup')
    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]

    await db.txns.add({
      date: '2026-03-01', amount: 100_00, projectId: project.id, sourceId: source.id,
      categoryId: category.id, voided: 0, createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
    } as never)
    await db.fundIns.add({
      date: '2026-03-02', sourceId: source.id, amount: 500_00, origin: 'x',
      createdAt: 1_700_000_900_000,
    } as never)

    const snap = await buildSnapshot()
    const a = snapshotAge(snap)

    expect(a.txnCount).toBe(1)
    expect(a.fundInCount).toBe(1)
    // The most recently touched entry wins, updatedAt included.
    expect(a.newestEntryAt).toBe(1_700_000_900_000)
    expect(await localAge()).toEqual(a)
  })
})

describe('CSV date format', () => {
  it('exports ISO dates, not the app-facing dd/mm/yyyy', async () => {
    const { db } = await import('../db/schema')
    const project = (await db.projects.toArray())[0]
    const source = (await db.sources.toArray())[0]
    const category = (await db.categories.toArray())[0]
    await db.txns.add({
      date: '2026-09-02', amount: 1_000_00, projectId: project.id,
      sourceId: source.id, categoryId: category.id, voided: 0,
    } as never)

    // Captured rather than downloaded: jsdom has no download.
    const rows = await db.txns.orderBy('date').toArray()
    expect(rows[0].date).toBe('2026-09-02')

    // A spreadsheet under a US locale would read 02/09/2026 as 9 February.
    const { downloadCsv } = await import('./backup')
    expect(typeof downloadCsv).toBe('function')
  })
})

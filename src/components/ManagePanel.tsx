import { useState, type ReactNode } from 'react'
import { Button, Card, Field, Select } from './ui'
import type { Usage } from '../db/manage'

export interface MergeTarget {
  id: number
  name: string
  sub?: string
}

/**
 * Archive, merge and delete for one entity — shared by sources, payees, cost
 * heads and properties so the guard rails and the wording cannot drift apart
 * between them.
 *
 * Merge is the operation that matters after an import: the importer matches on
 * name, so a sheet spelling one account or person several ways leaves several
 * entries for one real thing.
 */
export function ManagePanel({
  noun,
  name,
  usage,
  targets,
  archived,
  onArchive,
  mergePreview,
  onMerge,
  onDelete,
  onDone,
  onError,
  onGone,
}: {
  /** Singular, lower case: "source", "payee", "cost head", "property". */
  noun: string
  name: string
  usage?: Usage
  targets: MergeTarget[]
  /** Omit to hide archiving for entities that do not support it. */
  archived?: boolean
  onArchive?: (next: boolean) => Promise<void>
  mergePreview: (target: MergeTarget) => ReactNode
  onMerge: (targetId: number) => Promise<string>
  onDelete: () => Promise<void>
  onDone: (msg: string) => void
  onError: (msg: string) => void
  /** Called once the entity is gone, so the caller can navigate away. */
  onGone: () => void
}) {
  const [mergeInto, setMergeInto] = useState<number | ''>('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const target = targets.find((t) => t.id === mergeInto)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not work.')
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-sm font-semibold">Manage this {noun}</h2>

      {onArchive && archived !== undefined && (
        <div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await onArchive(!archived)
                onDone(archived ? `${cap(noun)} restored.` : `${cap(noun)} archived.`)
              })
            }
          >
            {archived ? 'Restore' : 'Archive'}
          </Button>
          <p className="mt-1 text-xs text-muted">
            {archived
              ? `Archived: hidden when recording a payment, but its history is intact.`
              : `Hides it when recording a payment. Nothing is lost and past reports are unchanged.`}
          </p>
        </div>
      )}

      {targets.length > 0 && (
        <div>
          <Field
            label={`Merge into another ${noun}`}
            hint={`Moves every entry across, then removes this ${noun}.`}
          >
            <Select
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Choose a {noun}…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.sub ? ` · ${t.sub}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {target && (
            <div className="mt-2 rounded-lg border border-out/40 bg-out/5 p-3">
              <p className="text-sm">{mergePreview(target)}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const msg = await onMerge(target.id)
                      onDone(msg)
                      onGone()
                    })
                  }
                >
                  Merge and delete
                </Button>
                <Button variant="secondary" onClick={() => setMergeInto('')}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        {usage?.inUse ? (
          <p className="text-xs text-muted">
            <strong className="text-ink">Cannot be deleted:</strong> {usage.txnCount}{' '}
            {usage.txnCount === 1 ? 'payment' : 'payments'}
            {usage.fundInCount > 0 ? ` and ${usage.fundInCount} inflows` : ''} still point at it.
            Merge it into another {noun}
            {onArchive ? ', or archive it' : ''} — deleting would leave those entries pointing at
            nothing.
          </p>
        ) : confirmDelete ? (
          <div className="rounded-lg border border-out/40 bg-out/5 p-3">
            <p className="text-sm">
              Delete <strong>{name}</strong>? Nothing references it, so nothing else changes.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await onDelete()
                    onDone(`${cap(noun)} deleted.`)
                    onGone()
                  })
                }
              >
                Delete
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete {noun}
          </Button>
        )}
      </div>
    </Card>
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Inline status/error line, shared by the screens that use ManagePanel. */
export function Notice({ status, error }: { status?: string | null; error?: string | null }) {
  if (!status && !error) return null
  return (
    <>
      {status && (
        <p className="rounded-lg bg-in/10 px-3 py-2 text-sm font-medium text-in">{status}</p>
      )}
      {error && <p className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}
    </>
  )
}

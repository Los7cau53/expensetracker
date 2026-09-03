import type { Id } from '../db/ids'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ManagePanel, Notice } from '../components/ManagePanel'
import { Button, Card, Empty, Field, Money, Screen, Stat, TextInput } from '../components/ui'
import {
  addCategory,
  categoryMergeTargets,
  categoryUsage,
  deleteCategory,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from '../db/manage'
import { db, type Category } from '../db/schema'
import { sum } from '../db/queries'

/**
 * Cost heads, with the cleanup an import demands: the wizard turns whatever was
 * in the chosen column into cost heads, so a sheet can leave entries like
 * "net banking main form" — really a source — sitting among the real ones.
 *
 * Rows expand in place rather than opening a screen each: there are two dozen
 * of these and they are one line of text apiece.
 */
export default function Categories() {
  const [openId, setOpenId] = useState<Id | null>(null)
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], [])
  const txns = useLiveQuery(() => db.txns.where('voided').equals(0).toArray(), [], [])

  const spendFor = (id: Id) => sum(txns.filter((t) => t.categoryId === id).map((t) => t.amount))
  const countFor = (id: Id) => txns.filter((t) => t.categoryId === id).length

  const visible = categories.filter((c) => showArchived || !c.archived)
  const archivedCount = categories.filter((c) => c.archived).length
  const unused = visible.filter((c) => countFor(c.id) === 0).length

  return (
    <Screen
      title="Cost heads"
      action={
        <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Cost heads" value={categories.length} />
          <Stat label="Never used" value={unused} />
          <Stat label="Archived" value={archivedCount} />
        </div>

        {adding && (
          <NewCategoryForm
            onDone={(m) => {
              setAdding(false)
              setStatus(m)
              setError(null)
            }}
            onError={setError}
          />
        )}

        <Notice status={status} error={error} />

        <label className="flex items-center gap-2 px-1 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>

        {visible.length === 0 ? (
          <Empty title="No cost heads" />
        ) : (
          <Card className="divide-y divide-line">
            {visible.map((c) => (
              <CategoryRow
                key={c.id}
                category={c}
                spent={spendFor(c.id)}
                count={countFor(c.id)}
                open={openId === c.id}
                onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                onDone={(m) => {
                  setStatus(m)
                  setError(null)
                }}
                onError={setError}
              />
            ))}
          </Card>
        )}

        <p className="px-1 text-xs text-muted">
          Tap a cost head to rename it, merge it into another, or archive it. Archived ones stay on
          old entries but leave the picker when recording a payment.
        </p>

        <Link to="/data" className="block px-1 text-sm text-accent">
          ← Data &amp; backup
        </Link>
      </div>
    </Screen>
  )
}

function CategoryRow({
  category,
  spent,
  count,
  open,
  onToggle,
  onDone,
  onError,
}: {
  category: Category
  spent: number
  count: number
  open: boolean
  onToggle: () => void
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(category.name)
  const usage = useLiveQuery(() => categoryUsage(category.id), [category.id])
  const targets = useLiveQuery(() => categoryMergeTargets(category.id), [category.id], [])

  async function rename() {
    try {
      await updateCategory(category.id, name)
      onDone('Cost head renamed.')
      onToggle()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not rename.')
    }
  }

  return (
    <div className={category.archived ? 'opacity-60' : ''}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-3 px-4 py-3 text-left hover:bg-ground"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {category.name}
            {category.archived ? ' · archived' : ''}
          </div>
          <div className="text-xs text-muted">
            {count === 0 ? 'never used' : `${count} ${count === 1 ? 'payment' : 'payments'}`}
          </div>
        </div>
        <span className="shrink-0 font-semibold">
          <Money paise={spent} />
        </span>
        <span aria-hidden className="shrink-0 self-center text-lg leading-none text-muted">
          ›
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line bg-ground/50 px-4 py-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button disabled={name.trim() === category.name} onClick={() => void rename()}>
            Rename
          </Button>

          <ManagePanel
            noun="cost head"
            name={category.name}
            usage={usage}
            archived={Boolean(category.archived)}
            onArchive={(next) => setCategoryArchived(category.id, next)}
            targets={targets.map((t) => ({ id: t.id, name: t.name }))}
            mergePreview={(t) => (
              <>
                Move {usage?.txnCount ?? 0} payments from <strong>{category.name}</strong> onto{' '}
                <strong>{t.name}</strong>, then delete <strong>{category.name}</strong>. This cannot
                be undone.
              </>
            )}
            onMerge={async (targetId) => {
              const r = await mergeCategories(category.id, targetId)
              return `Merged: moved ${r.movedTxns} payments.`
            }}
            onDelete={() => deleteCategory(category.id)}
            onDone={onDone}
            onError={onError}
            onGone={onToggle}
          />
        </div>
      )}
    </div>
  )
}

function NewCategoryForm({
  onDone,
  onError,
}: {
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')

  async function create() {
    try {
      await addCategory(name)
      onDone('Cost head added.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not add.')
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="e.g. Borewell"
        />
      </Field>
      <Button onClick={() => void create()} disabled={!name.trim()}>
        Add cost head
      </Button>
    </Card>
  )
}

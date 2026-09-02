import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { ComboBox } from '../components/ComboBox'
import { Button, Card, Empty, Field, Money, Screen, Select, TextInput } from '../components/ui'
import { filterTxns, sum, type TxnFilter } from '../db/queries'
import {
  db,
  type Category,
  type Payee,
  type Project,
  type Source,
  type Txn,
} from '../db/schema'
import { formatDate, formatMonth, monthOf } from '../lib/date'
import { guessPayeeRole } from '../lib/infer'
import { parseAmountToPaise } from '../lib/money'
import { usePref } from '../lib/prefs'

export default function Ledger() {
  const [filter, setFilter] = usePref<TxnFilter>('ledgerFilter', {})
  const [showFilters, setShowFilters] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.toArray(), [], [])
  const payees = useLiveQuery(() => db.payees.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], [])
  const txns = useLiveQuery(() => filterTxns(filter), [JSON.stringify(filter)], [])

  const name = {
    project: (id?: number) => projects.find((p) => p.id === id)?.name ?? '—',
    source: (id?: number) => sources.find((s) => s.id === id)?.name ?? '—',
    payee: (id?: number) => (id ? payees.find((p) => p.id === id)?.name ?? '—' : 'Unassigned'),
    category: (id?: number) => categories.find((c) => c.id === id)?.name ?? '—',
  }

  const total = sum(txns.filter((t) => t.voided === 0).map((t) => t.amount))
  const activeFilterCount = Object.values(filter).filter(
    (v) => v !== undefined && v !== '' && v !== false,
  ).length

  const months = [...new Set(txns.map((t) => monthOf(t.date)))]

  return (
    <Screen
      title="Ledger"
      action={
        <Button variant="secondary" onClick={() => setShowFilters((v) => !v)}>
          Filter{activeFilterCount ? ` (${activeFilterCount})` : ''}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <Card className="flex items-baseline justify-between px-4 py-3">
          <span className="text-sm text-muted">
            {txns.length} {txns.length === 1 ? 'entry' : 'entries'}
          </span>
          <span className="text-xl font-semibold">
            <Money paise={total} />
          </span>
        </Card>

        {showFilters && (
          <Card className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Property">
                <Select
                  value={filter.projectId ?? ''}
                  onChange={(e) =>
                    setFilter({ ...filter, projectId: e.target.value ? Number(e.target.value) : undefined })
                  }
                >
                  <option value="">All</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Paid to">
                <Select
                  value={filter.payeeId ?? ''}
                  onChange={(e) =>
                    setFilter({ ...filter, payeeId: e.target.value ? Number(e.target.value) : undefined })
                  }
                >
                  <option value="">All</option>
                  {payees.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Paid from">
                <Select
                  value={filter.sourceId ?? ''}
                  onChange={(e) =>
                    setFilter({ ...filter, sourceId: e.target.value ? Number(e.target.value) : undefined })
                  }
                >
                  <option value="">All</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="For what">
                <Select
                  value={filter.categoryId ?? ''}
                  onChange={(e) =>
                    setFilter({ ...filter, categoryId: e.target.value ? Number(e.target.value) : undefined })
                  }
                >
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="From">
                <TextInput
                  type="date"
                  value={filter.from ?? ''}
                  onChange={(e) => setFilter({ ...filter, from: e.target.value || undefined })}
                />
              </Field>
              <Field label="To">
                <TextInput
                  type="date"
                  value={filter.to ?? ''}
                  onChange={(e) => setFilter({ ...filter, to: e.target.value || undefined })}
                />
              </Field>
            </div>
            <Field label="Search notes and references">
              <TextInput
                value={filter.search ?? ''}
                onChange={(e) => setFilter({ ...filter, search: e.target.value || undefined })}
                placeholder="e.g. slab, cheque 41"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(filter.includeVoided)}
                onChange={(e) => setFilter({ ...filter, includeVoided: e.target.checked })}
              />
              Show voided entries
            </label>
            <Button variant="secondary" onClick={() => setFilter({})}>
              Clear filters
            </Button>
          </Card>
        )}

        {txns.length === 0 ? (
          <Empty
            title="No entries yet"
            hint="Record a payment from the Add tab, or import your Excel history from the Data screen."
          />
        ) : (
          months.map((m) => {
            const rows = txns.filter((t) => monthOf(t.date) === m)
            const monthTotal = sum(rows.filter((t) => t.voided === 0).map((t) => t.amount))
            return (
              <div key={m}>
                <div className="mb-1 flex items-baseline justify-between px-1">
                  <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {formatMonth(m)}
                  </h2>
                  <span className="tnum text-xs text-muted">
                    <Money paise={monthTotal} />
                  </span>
                </div>
                <Card className="divide-y divide-line">
                  {rows.map((t) => (
                    <TxnRow
                      key={t.id}
                      txn={t}
                      open={openId === t.id}
                      onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                      name={name}
                      projects={projects}
                      sources={sources}
                      payees={payees}
                      categories={categories}
                    />
                  ))}
                </Card>
              </div>
            )
          })
        )}
      </div>
    </Screen>
  )
}

function TxnRow({
  txn,
  open,
  onToggle,
  name,
  projects,
  sources,
  payees,
  categories,
}: {
  txn: Txn
  open: boolean
  onToggle: () => void
  name: Record<'project' | 'source' | 'payee' | 'category', (id?: number) => string>
  projects: Project[]
  sources: Source[]
  payees: Payee[]
  categories: Category[]
}) {
  // Draft state is seeded from the row and reset when the editor reopens, so
  // reassigning forty imported rows in a row does not carry values across.
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(txn.date)
  const [note, setNote] = useState(txn.note ?? '')
  const [payeeId, setPayeeId] = useState(txn.payeeId)
  const [categoryId, setCategoryId] = useState(txn.categoryId)
  const [sourceId, setSourceId] = useState(txn.sourceId)
  const [projectId, setProjectId] = useState(txn.projectId)
  const [saved, setSaved] = useState(false)

  async function saveEdits() {
    const paise = amount.trim() ? parseAmountToPaise(amount) : txn.amount
    if (paise === null) return
    await db.txns.update(txn.id, {
      amount: paise,
      date,
      note: note.trim() || undefined,
      payeeId,
      categoryId,
      sourceId,
      projectId,
      updatedAt: Date.now(),
    })
    setAmount('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    onToggle()
  }

  async function createPayee(nm: string) {
    return (await db.payees.add({
      name: nm,
      role: guessPayeeRole(nm),
      archived: 0,
      createdAt: Date.now(),
    } as never)) as number
  }

  /** Voiding preserves the row so a contractor dispute can still be traced. */
  async function toggleVoid() {
    await db.txns.update(txn.id, {
      voided: txn.voided ? 0 : 1,
      voidedAt: txn.voided ? undefined : Date.now(),
      updatedAt: Date.now(),
    })
  }

  const dirty =
    amount.trim() !== '' ||
    date !== txn.date ||
    (note.trim() || undefined) !== txn.note ||
    payeeId !== txn.payeeId ||
    categoryId !== txn.categoryId ||
    sourceId !== txn.sourceId ||
    projectId !== txn.projectId

  return (
    <div className={txn.voided ? 'opacity-50' : ''}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ground"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {/* Imported history often has no payee — falling back to the note
                or cost head keeps the list scannable instead of a column of
                identical "Unassigned" rows. */}
            {txn.payeeId ? name.payee(txn.payeeId) : txn.note || name.category(txn.categoryId)}
            {txn.voided ? ' · voided' : ''}
          </div>
          <div className="truncate text-xs text-muted">
            {formatDate(txn.date)}
            {txn.payeeId ? ` · ${name.category(txn.categoryId)}` : ' · no payee'} ·{' '}
            {name.source(txn.sourceId)}
          </div>
        </div>
        <span className={`shrink-0 font-semibold ${txn.voided ? 'line-through' : ''}`}>
          <Money paise={txn.amount} />
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line bg-ground/50 px-4 py-3">
          <Field label="Paid to" hint="Set this on imported rows that arrived without a payee.">
            <ComboBox
              options={payees.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, sub: p.role }))}
              value={payeeId}
              onChange={setPayeeId}
              onCreate={createPayee}
              allowClear
              placeholder="Mestri, electrician, supplier…"
            />
          </Field>

          <Field label="For what">
            <ComboBox
              options={categories.map((c) => ({ id: c.id, name: c.name }))}
              value={categoryId}
              onChange={(id) => id && setCategoryId(id)}
              placeholder="Permissions, masonry, cement…"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid from">
              <Select value={sourceId} onChange={(e) => setSourceId(Number(e.target.value))}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.type}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Property">
              <Select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Change amount">
              <TextInput
                inputMode="decimal"
                value={amount}
                placeholder="unchanged"
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Date">
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>

          <Field label="Note">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          {txn.refNo && <p className="text-xs text-muted">Reference: {txn.refNo}</p>}
          {saved && <p className="text-xs font-medium text-in">Saved.</p>}

          <div className="flex gap-2">
            <Button disabled={!dirty} onClick={() => void saveEdits()}>
              Save changes
            </Button>
            <Button variant="danger" onClick={() => void toggleVoid()}>
              {txn.voided ? 'Restore' : 'Void'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

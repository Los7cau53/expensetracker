import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ManagePanel, Notice } from '../components/ManagePanel'
import { Button, Card, Empty, Field, Money, Screen, Select, Stat, TextInput } from '../components/ui'
import { sum } from '../db/queries'
import {
  deleteSource,
  mergeSources,
  mergeTargets,
  setSourceArchived,
  sourceUsage,
  updateSource,
} from '../db/manage'
import { db, SOURCE_TYPES, type Source, type SourceType } from '../db/schema'
import { formatDate, todayStr } from '../lib/date'
import { formatPaise, parseAmountToPaise } from '../lib/money'

/**
 * A running statement for one source: opening balance, every rupee in, every
 * rupee out, in date order. This is the view that answers "can I pay the
 * steel supplier from this account this week".
 */
export default function SourceDetail() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  const [addingFunds, setAddingFunds] = useState(false)
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const source = useLiveQuery(() => db.sources.get(id), [id])
  const fundIns = useLiveQuery(() => db.fundIns.where('sourceId').equals(id).toArray(), [id], [])
  const txns = useLiveQuery(
    () => db.txns.where('[sourceId+voided]').equals([id, 0]).toArray(),
    [id],
    [],
  )
  const payees = useLiveQuery(() => db.payees.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.toArray(), [], [])
  const usage = useLiveQuery(() => sourceUsage(id), [id])
  const targets = useLiveQuery(() => mergeTargets(id), [id], [])

  if (!source) return <Screen title="Source"><Empty title="Source not found" /></Screen>

  const inflow = sum(fundIns.map((f) => f.amount))
  const outflow = sum(txns.map((t) => t.amount))
  const balance = source.openingBalance + inflow - outflow

  type Line = { date: string; label: string; sub: string; amount: number; kind: 'in' | 'out' }
  const lines: Line[] = [
    ...fundIns.map((f) => ({
      date: f.date,
      label: f.origin || 'Funds in',
      sub: f.note ?? '',
      amount: f.amount,
      kind: 'in' as const,
    })),
    ...txns.map((t) => ({
      date: t.date,
      label: t.payeeId ? payees.find((p) => p.id === t.payeeId)?.name ?? 'Unknown' : 'Unassigned',
      sub: categories.find((c) => c.id === t.categoryId)?.name ?? '',
      amount: t.amount,
      kind: 'out' as const,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <Screen
      title={source.name}
      action={
        <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel' : 'Edit'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="In" value={<Money paise={inflow + source.openingBalance} />} tone="text-in" />
          <Stat label="Out" value={<Money paise={outflow} />} tone="text-out" />
          <Stat label="Balance" value={<Money paise={balance} />} />
        </div>

        {editing && (
          <EditSourceForm
            source={source}
            onDone={(msg) => {
              setEditing(false)
              setStatus(msg)
              setError(null)
            }}
            onError={setError}
          />
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAddingFunds((v) => !v)}>
            {addingFunds ? 'Cancel' : 'Add funds in'}
          </Button>
        </div>

        {addingFunds && <FundInForm sourceId={id} onDone={() => setAddingFunds(false)} />}

        <Notice status={status} error={error} />

        {lines.length === 0 ? (
          <Empty title="Nothing recorded against this source yet" />
        ) : (
          <Card className="divide-y divide-line">
            {lines.map((l, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.label}</div>
                  <div className="truncate text-xs text-muted">
                    {formatDate(l.date)}
                    {l.sub ? ` · ${l.sub}` : ''}
                  </div>
                </div>
                <span className={`shrink-0 font-semibold ${l.kind === 'in' ? 'text-in' : 'text-out'}`}>
                  {l.kind === 'in' ? '+' : '−'}
                  <Money paise={l.amount} />
                </span>
              </div>
            ))}
          </Card>
        )}

        <ManagePanel
          noun="source"
          name={source.name}
          usage={usage}
          archived={Boolean(source.archived)}
          onArchive={(next) => setSourceArchived(id, next)}
          targets={targets.map((t) => ({ id: t.id, name: t.name, sub: t.type }))}
          mergePreview={(t) => {
            const into = targets.find((x) => x.id === t.id)!
            return (
              <>
                Move {usage?.txnCount ?? 0} payments and {usage?.fundInCount ?? 0} inflows from{' '}
                <strong>{source.name}</strong> into <strong>{t.name}</strong>, then delete{' '}
                <strong>{source.name}</strong>. Opening balances add up to{' '}
                <span className="tnum">
                  {formatPaise(source.openingBalance + into.openingBalance)}
                </span>
                . This cannot be undone.
              </>
            )
          }}
          onMerge={async (targetId) => {
            const r = await mergeSources(id, targetId)
            return `Merged: moved ${r.movedTxns} payments and ${r.movedFundIns} inflows.`
          }}
          onDelete={() => deleteSource(id)}
          onDone={(m) => {
            setStatus(m)
            setError(null)
          }}
          onError={setError}
          onGone={() => navigate('/sources')}
        />

        <Link to="/sources" className="block px-1 text-sm text-accent">
          ← All sources
        </Link>
      </div>
    </Screen>
  )
}

function FundInForm({ sourceId, onDone }: { sourceId: number; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [origin, setOrigin] = useState('')
  const [date, setDate] = useState(todayStr())
  const [note, setNote] = useState('')

  const paise = parseAmountToPaise(amount)

  async function create() {
    if (paise === null || paise <= 0) return
    await db.fundIns.add({
      sourceId,
      date,
      amount: paise,
      origin: origin.trim() || 'Funds in',
      note: note.trim() || undefined,
      createdAt: Date.now(),
    } as never)
    onDone()
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Date">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Where it came from" hint="Loan disbursement, salary transfer, own savings, sale proceeds.">
        <TextInput value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="HDFC home loan tranche 2" />
      </Field>
      <Field label="Note">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </Field>
      <Button onClick={() => void create()} disabled={paise === null || paise <= 0}>
        Record funds in
      </Button>
    </Card>
  )
}

function EditSourceForm({
  source,
  onDone,
  onError,
}: {
  source: Source
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(source.name)
  const [type, setType] = useState<SourceType>(source.type)
  const [institution, setInstitution] = useState(source.institution ?? '')
  const [opening, setOpening] = useState((source.openingBalance / 100).toString())
  const [notes, setNotes] = useState(source.notes ?? '')

  async function save() {
    const paise = parseAmountToPaise(opening)
    if (paise === null) {
      onError('Opening balance is not a valid amount.')
      return
    }
    try {
      await updateSource(source.id, {
        name,
        type,
        institution,
        openingBalance: paise,
        notes,
      })
      onDone('Source updated.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save.')
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type" hint="The importer guesses this; correct it here.">
          <Select value={type} onChange={(e) => setType(e.target.value as SourceType)}>
            {SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Institution">
          <TextInput
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="SBI, HDFC, GPay"
          />
        </Field>
      </div>
      <Field label="Opening balance" hint="What sat here before you started tracking.">
        <TextInput inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
      </Field>
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <Button onClick={() => void save()} disabled={!name.trim()}>
        Save changes
      </Button>
    </Card>
  )
}

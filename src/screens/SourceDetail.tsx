import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Card, Empty, Field, Money, Screen, Stat, TextInput } from '../components/ui'
import { sum } from '../db/queries'
import { db } from '../db/schema'
import { formatDate, todayStr } from '../lib/date'
import { parseAmountToPaise } from '../lib/money'

/**
 * A running statement for one source: opening balance, every rupee in, every
 * rupee out, in date order. This is the view that answers "can I pay the
 * steel supplier from this account this week".
 */
export default function SourceDetail() {
  const id = Number(useParams().id)
  const [addingFunds, setAddingFunds] = useState(false)

  const source = useLiveQuery(() => db.sources.get(id), [id])
  const fundIns = useLiveQuery(() => db.fundIns.where('sourceId').equals(id).toArray(), [id], [])
  const txns = useLiveQuery(
    () => db.txns.where('[sourceId+voided]').equals([id, 0]).toArray(),
    [id],
    [],
  )
  const payees = useLiveQuery(() => db.payees.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.toArray(), [], [])

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
        <Button variant="secondary" onClick={() => setAddingFunds((v) => !v)}>
          {addingFunds ? 'Cancel' : 'Add funds in'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="In" value={<Money paise={inflow + source.openingBalance} />} tone="text-in" />
          <Stat label="Out" value={<Money paise={outflow} />} tone="text-out" />
          <Stat label="Balance" value={<Money paise={balance} />} />
        </div>

        {addingFunds && <FundInForm sourceId={id} onDone={() => setAddingFunds(false)} />}

        <OpeningBalanceEditor sourceId={id} current={source.openingBalance} />

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

function OpeningBalanceEditor({ sourceId, current }: { sourceId: number; current: number }) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)

  async function save() {
    const paise = parseAmountToPaise(value)
    if (paise === null) return
    await db.sources.update(sourceId, { openingBalance: paise })
    setOpen(false)
    setValue('')
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="px-1 text-sm text-accent">
        Opening balance: <Money paise={current} /> — change
      </button>
    )
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Opening balance" hint="What sat in this source before you started tracking.">
        <TextInput inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder={String(current / 100)} />
      </Field>
      <div className="flex gap-2">
        <Button onClick={() => void save()}>Save</Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  )
}

import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Field, Money, Screen, Select, Stat, TextInput } from '../components/ui'
import { sourceBalances, sum } from '../db/queries'
import { db, SOURCE_TYPES, type SourceType } from '../db/schema'
import { parseAmountToPaise } from '../lib/money'

export default function Sources() {
  const balances = useLiveQuery(() => sourceBalances(), [], [])
  const [adding, setAdding] = useState(false)

  const totalIn = sum(balances.map((b) => b.inflow + b.source.openingBalance))
  const totalOut = sum(balances.map((b) => b.outflow))

  return (
    <Screen
      title="Fund sources"
      action={
        <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New source'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Funds in" value={<Money paise={totalIn} />} tone="text-in" />
          <Stat label="Spent" value={<Money paise={totalOut} />} tone="text-out" />
          <Stat label="Available" value={<Money paise={totalIn - totalOut} />} />
        </div>

        {adding && <NewSourceForm onDone={() => setAdding(false)} />}

        <Card className="divide-y divide-line">
          {balances.map(({ source, inflow, outflow, balance, txnCount }) => (
            <Link
              key={source.id}
              to={`/sources/${source.id}`}
              className="block px-4 py-3 hover:bg-ground"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {source.name}
                    {source.archived ? ' · archived' : ''}
                  </div>
                  <div className="text-xs text-muted">
                    {source.type}
                    {source.institution ? ` · ${source.institution}` : ''} · {txnCount} payments
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold">
                    <Money paise={balance} />
                  </div>
                  <div className="tnum text-xs text-muted">
                    in <Money paise={inflow + source.openingBalance} /> · out{' '}
                    <Money paise={outflow} />
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </Card>

        <p className="px-1 text-xs text-muted">
          Available assumes every rupee that entered a source is recorded here. Add loan
          disbursements and transfers as funds in, or balances will read low.
        </p>
      </div>
    </Screen>
  )
}

function NewSourceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<SourceType>('bank')
  const [institution, setInstitution] = useState('')
  const [opening, setOpening] = useState('')

  async function create() {
    if (!name.trim()) return
    await db.sources.add({
      name: name.trim(),
      type,
      institution: institution.trim() || undefined,
      openingBalance: parseAmountToPaise(opening) ?? 0,
      archived: 0,
      createdAt: Date.now(),
    } as never)
    onDone()
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="SBI savings · 4471"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
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
      <Field label="Opening balance" hint="What was already in it when you started tracking.">
        <TextInput inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" />
      </Field>
      <Button onClick={() => void create()} disabled={!name.trim()}>
        Add source
      </Button>
    </Card>
  )
}

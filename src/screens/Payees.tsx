import type { Id } from '../db/ids'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Empty, Field, Money, Screen, Select, Stat, TextInput } from '../components/ui'
import { payeeTotals, sum } from '../db/queries'
import { db, PAYEE_ROLES, type PayeeRole } from '../db/schema'
import { formatDate } from '../lib/date'
import { usePref } from '../lib/prefs'

/** Answers "whom has the money gone to" across every property. */
export default function Payees() {
  const [projectId, setProjectId] = usePref<Id | undefined>('payeeScope', undefined)
  const [roleFilter, setRoleFilter] = useState<PayeeRole | ''>('')
  const [adding, setAdding] = useState(false)

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const totals = useLiveQuery(() => payeeTotals(projectId), [projectId], [])

  const visible = totals
    .filter((t) => (roleFilter ? t.payee.role === roleFilter : true))
    // Someone with no payments is noise here; they still exist for the picker.
    .filter((t) => t.txnCount > 0 || !roleFilter)

  const grandTotal = sum(visible.map((t) => t.total))
  const paidCount = visible.filter((t) => t.txnCount > 0).length

  return (
    <Screen
      title="Paid to"
      action={
        <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New payee'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Total paid out" value={<Money paise={grandTotal} />} />
          <Stat label="People & suppliers" value={paidCount} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Property">
            <Select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value || undefined)}
            >
              <option value="">All properties</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as PayeeRole | '')}>
              <option value="">All roles</option>
              {PAYEE_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
        </div>

        {adding && <NewPayeeForm onDone={() => setAdding(false)} />}

        <p className="px-1 text-xs text-muted">
          Tap a payee to rename them, fix their role, merge duplicates together or archive them.
        </p>

        {visible.length === 0 ? (
          <Empty title="No payees yet" hint="They get created as you record payments." />
        ) : (
          <Card className="divide-y divide-line">
            {visible.map(({ payee, total, txnCount, lastPaid }) => (
              <Link
                key={payee.id}
                to={`/payees/${payee.id}`}
                className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-ground"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{payee.name}</div>
                  <div className="truncate text-xs text-muted">
                    {payee.role} · {txnCount} {txnCount === 1 ? 'payment' : 'payments'}
                    {lastPaid ? ` · last ${formatDate(lastPaid)}` : ''}
                  </div>
                </div>
                <span className="shrink-0 font-semibold">
                  <Money paise={total} />
                </span>
                <span aria-hidden className="shrink-0 self-center text-lg leading-none text-muted">
                  ›
                </span>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </Screen>
  )
}

function NewPayeeForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<PayeeRole>('mestri')
  const [phone, setPhone] = useState('')

  async function create() {
    if (!name.trim()) return
    await db.payees.add({
      name: name.trim(),
      role,
      phone: phone.trim() || undefined,
      archived: 0,
      createdAt: Date.now(),
    } as never)
    onDone()
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ramesh mestri" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as PayeeRole)}>
            {PAYEE_ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Phone">
          <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Optional" />
        </Field>
      </div>
      <Button onClick={() => void create()} disabled={!name.trim()}>
        Add payee
      </Button>
    </Card>
  )
}

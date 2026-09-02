import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ComboBox } from '../components/ComboBox'
import { Button, Field, Screen, Select, TextInput } from '../components/ui'
import { db, PAYEE_ROLES, type PayeeRole } from '../db/schema'
import { todayStr } from '../lib/date'
import { guessPayeeRole } from '../lib/infer'
import { formatPaise, parseAmountToPaise } from '../lib/money'
import { usePref } from '../lib/prefs'

export default function AddEntry() {
  const navigate = useNavigate()

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.where('archived').equals(0).toArray(), [], [])
  const payees = useLiveQuery(() => db.payees.where('archived').equals(0).toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], [])

  // Project, source and category persist between entries: at a site you record
  // six payments in a row against the same property, and re-picking each time
  // is the friction that sends people back to a notebook.
  const [projectId, setProjectId] = usePref<number | undefined>('lastProject', undefined)
  const [sourceId, setSourceId] = usePref<number | undefined>('lastSource', undefined)
  const [categoryId, setCategoryId] = usePref<number | undefined>('lastCategory', undefined)

  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayStr())
  const [payeeId, setPayeeId] = useState<number | undefined>()
  const [note, setNote] = useState('')
  const [refNo, setRefNo] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveProject = projectId ?? projects[0]?.id
  const effectiveSource = sourceId ?? sources[0]?.id
  const paise = parseAmountToPaise(amount)
  const selectedPayee = payees.find((p) => p.id === payeeId)

  const canSave = paise !== null && paise > 0 && effectiveProject && effectiveSource && categoryId

  async function save(andAnother: boolean) {
    setError(null)
    if (!canSave) {
      setError('Enter an amount and pick a project, category and source.')
      return
    }
    const now = Date.now()
    await db.txns.add({
      date,
      projectId: effectiveProject!,
      amount: paise!,
      sourceId: effectiveSource!,
      payeeId,
      categoryId: categoryId!,
      note: note.trim() || undefined,
      refNo: refNo.trim() || undefined,
      voided: 0,
      createdAt: now,
      updatedAt: now,
    } as never)

    setSaved(`Saved ${formatPaise(paise!)}`)
    setAmount('')
    setNote('')
    setRefNo('')

    if (andAnother) {
      // Keep payee and date — consecutive site entries usually share both.
      setTimeout(() => setSaved(null), 2200)
    } else {
      navigate('/ledger')
    }
  }

  async function createPayee(name: string) {
    return (await db.payees.add({
      name,
      // Inferred from the name, the same way the importer does it, so typing
      // "Ramesh mestri" does not then ask what a mestri is.
      role: guessPayeeRole(name),
      archived: 0,
      createdAt: Date.now(),
    } as never)) as number
  }

  async function setPayeeRole(role: PayeeRole) {
    if (payeeId) await db.payees.update(payeeId, { role })
  }

  return (
    <Screen title="Add payment">
      <div className="mx-auto max-w-2xl space-y-4">
        <Field label="Amount paid">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoFocus
            placeholder="0"
            aria-label="Amount in rupees"
            className="tnum w-full rounded-xl border border-line bg-surface px-4 py-4 text-4xl font-semibold outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {amount && paise === null && (
            <span className="mt-1 block text-xs text-out">Not a valid amount.</span>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Property">
            <Select
              value={effectiveProject ?? ''}
              onChange={(e) => setProjectId(Number(e.target.value))}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Paid to" hint="Leave empty for counter payments with no named recipient.">
          <ComboBox
            options={payees.map((p) => ({ id: p.id, name: p.name, sub: p.role }))}
            value={payeeId}
            onChange={setPayeeId}
            onCreate={createPayee}
            allowClear
            placeholder="Mestri, electrician, supplier…"
          />
        </Field>

        {selectedPayee?.role === 'other' && (
          <Field label={`What does ${selectedPayee.name} do?`} hint="Sets their role for role-wise reports.">
            <Select defaultValue="other" onChange={(e) => void setPayeeRole(e.target.value as PayeeRole)}>
              {PAYEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="For what">
          <ComboBox
            options={categories.map((c) => ({ id: c.id, name: c.name }))}
            value={categoryId}
            onChange={setCategoryId}
            placeholder="Permissions, masonry, cement…"
          />
        </Field>

        <Field label="Paid from">
          <Select
            value={effectiveSource ?? ''}
            onChange={(e) => setSourceId(Number(e.target.value))}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.type}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Note">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Reference" hint="UPI ref, cheque no.">
            <TextInput value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="Optional" />
          </Field>
        </div>

        {error && <p className="text-sm text-out">{error}</p>}
        {saved && (
          <p className="rounded-lg bg-in/10 px-3 py-2 text-sm font-medium text-in">{saved}</p>
        )}

        <div className="flex gap-3 pt-1">
          <Button className="flex-1" disabled={!canSave} onClick={() => void save(true)}>
            Save &amp; add another
          </Button>
          <Button variant="secondary" disabled={!canSave} onClick={() => void save(false)}>
            Save
          </Button>
        </div>
      </div>
    </Screen>
  )
}

import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ComboBox } from '../components/ComboBox'
import { ScreenshotReader } from '../components/ScreenshotReader'
import { Button, Field, Screen, Select, TextInput } from '../components/ui'
import { db, PAYEE_ROLES, type PayeeRole } from '../db/schema'
import { todayStr } from '../lib/date'
import { receiptNote, type ReceiptFields } from '../lib/gpay'
import { guessPayeeRole } from '../lib/infer'
import { formatPaise, parseAmountToPaise } from '../lib/money'
import { usePref } from '../lib/prefs'

export default function AddEntry() {
  const navigate = useNavigate()

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.where('archived').equals(0).toArray(), [], [])
  const payees = useLiveQuery(() => db.payees.where('archived').equals(0).toArray(), [], [])
  const categories = useLiveQuery(
    // Archived cost heads stay on old entries but leave the picker.
    () => db.categories.orderBy('sortOrder').filter((c) => !c.archived).toArray(),
    [],
    [],
  )

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
  const [reading, setReading] = useState(false)
  const [matchNote, setMatchNote] = useState<string | null>(null)

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

  /**
   * Applies what a screenshot gave us. Anything already typed is left alone —
   * the reader assists, it does not overwrite the reader's own corrections.
   */
  async function applyReceipt(f: ReceiptFields) {
    const notes: string[] = []

    if (f.amount) setAmount((f.amount / 100).toString())
    if (f.date) setDate(f.date)
    if (f.reference) setRefNo(f.reference)

    const note = receiptNote(f)
    if (note) setNote(note)

    // Match the recipient onto an existing payee before creating another one;
    // the whole point of merging duplicates was to stop them multiplying.
    if (f.payee) {
      const norm = (v: string) => v.trim().toLowerCase()
      const hit = payees.find((p) => norm(p.name) === norm(f.payee!))
      if (hit) setPayeeId(hit.id)
      else {
        const id = (await db.payees.add({
          name: f.payee,
          role: guessPayeeRole(f.payee),
          archived: 0,
          createdAt: Date.now(),
        } as never)) as number
        setPayeeId(id)
        notes.push(`added "${f.payee}" as a new payee`)
      }
    }

    // The bank is matched on its last four digits first, since a source is
    // usually named for the account rather than exactly as the receipt spells
    // the bank.
    if (f.bankLast4 || f.bank) {
      const hit =
        (f.bankLast4 && sources.find((s) => s.name.includes(f.bankLast4!))) ||
        (f.bank && sources.find((s) => s.name.toLowerCase().includes(f.bank!.toLowerCase()))) ||
        (f.bank &&
          sources.find((s) =>
            (s.institution ?? '').toLowerCase().includes(f.bank!.split(' ')[0].toLowerCase()),
          ))
      if (hit) setSourceId(hit.id)
      else {
        const label = [f.bank, f.bankLast4].filter(Boolean).join(' ')
        notes.push(`no source matches "${label}" — pick one, or add it on the Sources tab`)
      }
    }

    setMatchNote(notes.length ? notes.join('. ') : null)
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
        {reading ? (
          <ScreenshotReader onExtract={(f) => void applyReceipt(f)} onClose={() => setReading(false)} />
        ) : (
          <Button variant="secondary" className="w-full" onClick={() => setReading(true)}>
            Read a payment screenshot
          </Button>
        )}

        {matchNote && (
          <p className="rounded-lg bg-accent/5 px-3 py-2 text-xs text-muted">{matchNote}</p>
        )}

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

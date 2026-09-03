import { byCreated, type Id } from '../db/ids'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ComboBox } from '../components/ComboBox'
import { DateField } from '../components/DateField'
import { ScreenshotReader } from '../components/ScreenshotReader'
import { Button, Field, FieldGroup, Screen, Select, TextInput } from '../components/ui'
import { db, PAYEE_ROLES, type PayeeRole } from '../db/schema'
import { todayStr } from '../lib/date'
import {
  createCategoryByName,
  createPayeeByName,
  createProjectByName,
  createSourceByName,
  guessedSourceTypeFor,
} from '../db/create'
import { receiptNote, type ReceiptFields } from '../lib/gpay'
import { guessPayeeRole } from '../lib/infer'
import { formatPaise, parseAmountToPaise } from '../lib/money'
import { usePref } from '../lib/prefs'

export default function AddEntry() {
  const navigate = useNavigate()

  // Explicitly ordered: UUID primary keys give no meaningful default order,
  // and these lists decide which project and source a new entry defaults to.
  const projects = useLiveQuery(async () => byCreated(await db.projects.toArray()), [], [])
  const sources = useLiveQuery(
    async () => byCreated(await db.sources.where('archived').equals(0).toArray()),
    [],
    [],
  )
  const payees = useLiveQuery(
    async () => byCreated(await db.payees.where('archived').equals(0).toArray()),
    [],
    [],
  )
  const categories = useLiveQuery(
    // Archived cost heads stay on old entries but leave the picker.
    () => db.categories.orderBy('sortOrder').filter((c) => !c.archived).toArray(),
    [],
    [],
  )

  // Project, source and category persist between entries: at a site you record
  // six payments in a row against the same property, and re-picking each time
  // is the friction that sends people back to a notebook.
  const [projectId, setProjectId] = usePref<Id | undefined>('lastProject', undefined)
  const [sourceId, setSourceId] = usePref<Id | undefined>('lastSource', undefined)
  const [categoryId, setCategoryId] = usePref<Id | undefined>('lastCategory', undefined)

  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayStr())
  const [payeeId, setPayeeId] = useState<Id | undefined>()
  const [note, setNote] = useState('')
  const [refNo, setRefNo] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [matchNote, setMatchNote] = useState<string | null>(null)
  // What was just created inline, so a guessed source type is not a surprise.
  const [created, setCreated] = useState<string | null>(null)

  const effectiveProject = projectId ?? projects[0]?.id
  const effectiveSource = sourceId ?? sources[0]?.id
  const paise = parseAmountToPaise(amount)
  const selectedPayee = payees.find((p) => p.id === payeeId)

  const negative = paise !== null && paise < 0
  // Negatives are allowed: a reversed online payment or a refund has to reduce
  // net spend. The importer has always kept them and every total already nets
  // them; only this screen refused, so the two disagreed. Zero is still
  // rejected — it records nothing.
  const canSave =
    paise !== null && paise !== 0 && effectiveProject && effectiveSource && categoryId

  async function save(andAnother: boolean) {
    setError(null)
    if (paise === 0) {
      setError('An amount of zero records nothing.')
      return
    }
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
    setCreated(null)

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
        } as never)) as string
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
    const id = await createPayeeByName(name)
    setCreated(`added "${name}" as a new payee`)
    return id
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
        {created && (
          <p className="rounded-lg bg-in/10 px-3 py-2 text-xs text-muted">{created}</p>
        )}

        <FieldGroup label="Amount paid">
          <div className="flex items-stretch gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoFocus
              placeholder="0"
              aria-label="Amount in rupees"
              className={`tnum min-w-0 flex-1 rounded-xl border bg-surface px-4 py-4 text-4xl font-semibold outline-none focus:ring-2 focus:ring-accent/20 ${
                negative ? 'border-out text-out' : 'border-line focus:border-accent'
              }`}
            />
            {/* A sign toggle, not just a typed minus: iOS's decimal keypad has
                no minus key, so on a phone the sign is otherwise unreachable. */}
            <button
              type="button"
              onClick={() => setAmount((v) => (v.trim().startsWith('-') ? v.replace(/^\s*-/, '') : `-${v.trim()}`))}
              aria-label={negative ? 'Make this a payment out' : 'Make this a reversal or refund'}
              aria-pressed={negative}
              className={`w-16 shrink-0 rounded-xl border text-2xl font-semibold transition ${
                negative
                  ? 'border-out bg-out/10 text-out'
                  : 'border-line bg-surface text-muted hover:bg-ground'
              }`}
            >
              {negative ? '−' : '+'}
            </button>
          </div>

          {negative && (
            <span className="mt-1 block text-xs text-out">
              Recorded as a reversal: it reduces net spend and puts the money back on the source.
            </span>
          )}
          {amount && paise === null && (
            <span className="mt-1 block text-xs text-out">Not a valid amount.</span>
          )}
          {paise === 0 && amount.trim() !== '' && (
            <span className="mt-1 block text-xs text-out">Zero records nothing.</span>
          )}
        </FieldGroup>

        <div className="grid grid-cols-2 gap-3">
          <FieldGroup label="Date">
            <DateField value={date} onChange={setDate} />
          </FieldGroup>
          <FieldGroup label="Property">
            <ComboBox
              options={projects.map((p) => ({ id: p.id, name: p.name }))}
              value={effectiveProject}
              onChange={setProjectId}
              onCreate={async (name) => {
                const id = await createProjectByName(name)
                setCreated(`added "${name}" as a new property`)
                return id
              }}
              placeholder="Which property…"
            />
          </FieldGroup>
        </div>

        <FieldGroup label="Paid to" hint="Leave empty for counter payments with no named recipient.">
          <ComboBox
            options={payees.map((p) => ({ id: p.id, name: p.name, sub: p.role }))}
            value={payeeId}
            onChange={setPayeeId}
            onCreate={createPayee}
            allowClear
            placeholder="Mestri, electrician, supplier…"
          />
        </FieldGroup>

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

        <FieldGroup label="For what">
          <ComboBox
            options={categories.map((c) => ({ id: c.id, name: c.name }))}
            value={categoryId}
            onChange={setCategoryId}
            onCreate={async (name) => {
              const id = await createCategoryByName(name)
              setCreated(`added "${name}" as a new cost head`)
              return id
            }}
            placeholder="Permissions, masonry, cement…"
          />
        </FieldGroup>

        <FieldGroup label="Paid from">
          <ComboBox
            options={sources.map((s) => ({ id: s.id, name: s.name, sub: s.type }))}
            value={effectiveSource}
            onChange={setSourceId}
            onCreate={async (name) => {
              const id = await createSourceByName(name)
              setCreated(
                `added "${name}" as a new ${guessedSourceTypeFor(name)} source — change its type in Settings if that is wrong`,
              )
              return id
            }}
            placeholder="Cash, SBI, GPay…"
          />
        </FieldGroup>

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

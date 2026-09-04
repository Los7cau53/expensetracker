import { byCreated, type Id } from '../db/ids'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ComboBox } from '../components/ComboBox'
import { DateField } from '../components/DateField'
import { ScreenshotReader } from '../components/ScreenshotReader'
import { Button, Field, FieldGroup, Screen, Select, TextInput } from '../components/ui'
import { db, PAYEE_ROLES, type PayeeRole, type TxnKind } from '../db/schema'
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

/** The three ways a payment can be recorded, and how the form labels each. */
const KINDS: { key: TxnKind; label: string; blurb: string }[] = [
  { key: 'expense', label: 'Payment', blurb: 'Money you paid, out of one of your sources.' },
  {
    key: 'onbehalf',
    label: 'Paid on my behalf',
    blurb: 'Someone else paid for this. It counts toward the cost head and you now owe them.',
  },
  {
    key: 'settlement',
    label: 'Repay someone',
    blurb: 'Pay back money someone fronted. Moves your money without re-counting the cost head.',
  },
]

/** Prefill handed over from the Repay button on a payee's page. */
interface AddPrefill {
  kind?: TxnKind
  payeeId?: Id
  amount?: string
}

export default function AddEntry() {
  const navigate = useNavigate()
  const prefill = (useLocation().state as AddPrefill | null) ?? null

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

  const [kind, setKind] = useState<TxnKind>(prefill?.kind ?? 'expense')

  // Project, source and category persist between entries: at a site you record
  // six payments in a row against the same property, and re-picking each time
  // is the friction that sends people back to a notebook.
  const [projectId, setProjectId] = usePref<Id | undefined>('lastProject', undefined)
  const [sourceId, setSourceId] = usePref<Id | undefined>('lastSource', undefined)
  const [categoryId, setCategoryId] = usePref<Id | undefined>('lastCategory', undefined)

  const [amount, setAmount] = useState(prefill?.amount ?? '')
  const [date, setDate] = useState(todayStr())
  // The person the money reaches: the recipient on a payment, the person being
  // repaid on a settlement.
  const [payeeId, setPayeeId] = useState<Id | undefined>(prefill?.payeeId)
  // The person who fronted the money, on an on-behalf entry.
  const [fronterId, setFronterId] = useState<Id | undefined>()
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

  const needsSource = kind !== 'onbehalf'
  const needsCategory = kind !== 'settlement'

  const negative = paise !== null && paise < 0
  // Negatives are allowed on a payment: a reversed online payment or a refund
  // has to reduce net spend. Zero is always rejected — it records nothing.
  const canSave =
    paise !== null &&
    paise !== 0 &&
    Boolean(effectiveProject) &&
    (!needsSource || Boolean(effectiveSource)) &&
    (!needsCategory || Boolean(categoryId)) &&
    (kind !== 'onbehalf' || Boolean(fronterId)) &&
    (kind !== 'settlement' || Boolean(payeeId))

  async function save(andAnother: boolean) {
    setError(null)
    if (paise === 0) {
      setError('An amount of zero records nothing.')
      return
    }
    if (!canSave) {
      setError(problem())
      return
    }
    const now = Date.now()
    const base = {
      date,
      projectId: effectiveProject!,
      amount: paise!,
      note: note.trim() || undefined,
      refNo: refNo.trim() || undefined,
      voided: 0 as const,
      createdAt: now,
      updatedAt: now,
    }

    if (kind === 'onbehalf') {
      await db.txns.add({
        ...base,
        kind: 'onbehalf',
        fronterId,
        categoryId: categoryId!,
      } as never)
    } else if (kind === 'settlement') {
      await db.txns.add({
        ...base,
        kind: 'settlement',
        payeeId,
        sourceId: effectiveSource!,
      } as never)
    } else {
      await db.txns.add({
        ...base,
        kind: 'expense',
        payeeId,
        categoryId: categoryId!,
        sourceId: effectiveSource!,
      } as never)
    }

    setSaved(`Saved ${formatPaise(paise!)}`)
    setAmount('')
    setNote('')
    setRefNo('')
    setCreated(null)

    if (andAnother) {
      // Keep payee/fronter and date — consecutive site entries usually share both.
      setTimeout(() => setSaved(null), 2200)
    } else {
      navigate('/ledger')
    }
  }

  /** A specific reason the current form cannot be saved yet. */
  function problem(): string {
    if (kind === 'onbehalf')
      return 'Enter an amount and pick a property, cost head and who paid on your behalf.'
    if (kind === 'settlement')
      return 'Enter an amount and pick who you are repaying and the source it comes from.'
    return 'Enter an amount and pick a project, category and source.'
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

  const activeKind = KINDS.find((k) => k.key === kind)!

  return (
    <Screen title="Add payment">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <div
            className="flex rounded-lg border border-line bg-surface p-0.5"
            role="group"
            aria-label="What to record"
          >
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                aria-pressed={kind === k.key}
                onClick={() => setKind(k.key)}
                className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition ${
                  kind === k.key ? 'bg-accent text-white' : 'text-muted hover:bg-ground'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <p className="mt-2 px-1 text-xs text-muted">{activeKind.blurb}</p>
        </div>

        {kind === 'expense' &&
          (reading ? (
            <ScreenshotReader onExtract={(f) => void applyReceipt(f)} onClose={() => setReading(false)} />
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setReading(true)}>
              Read a payment screenshot
            </Button>
          ))}

        {matchNote && (
          <p className="rounded-lg bg-accent/5 px-3 py-2 text-xs text-muted">{matchNote}</p>
        )}
        {created && (
          <p className="rounded-lg bg-in/10 px-3 py-2 text-xs text-muted">{created}</p>
        )}

        <FieldGroup
          label={
            kind === 'onbehalf' ? 'Amount they paid' : kind === 'settlement' ? 'Amount to repay' : 'Amount paid'
          }
        >
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

          {negative && kind === 'expense' && (
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

        {kind === 'onbehalf' && (
          <FieldGroup label="Paid by" hint="Who fronted the money — you will owe them until you repay.">
            <ComboBox
              options={payees.map((p) => ({ id: p.id, name: p.name, sub: p.role }))}
              value={fronterId}
              onChange={setFronterId}
              onCreate={createPayee}
              placeholder="Mestri, partner, relative…"
            />
          </FieldGroup>
        )}

        {kind === 'settlement' && (
          <FieldGroup label="Repay to" hint="The person you are paying back.">
            <ComboBox
              options={payees.map((p) => ({ id: p.id, name: p.name, sub: p.role }))}
              value={payeeId}
              onChange={setPayeeId}
              onCreate={createPayee}
              placeholder="Who fronted the money…"
            />
          </FieldGroup>
        )}

        {kind === 'expense' && (
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
        )}

        {kind === 'expense' && selectedPayee?.role === 'other' && (
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

        {needsCategory && (
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
        )}

        {needsSource && (
          <FieldGroup label={kind === 'settlement' ? 'Repay from' : 'Paid from'}>
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
        )}

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

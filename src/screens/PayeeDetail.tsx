import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ManagePanel, Notice } from '../components/ManagePanel'
import {
  Bar,
  Button,
  Card,
  Empty,
  Field,
  Money,
  Screen,
  Select,
  Stat,
  TextInput,
} from '../components/ui'
import { sum } from '../db/queries'
import {
  deletePayee,
  mergePayees,
  payeeMergeTargets,
  payeeUsage,
  setPayeeArchived,
  updatePayee,
} from '../db/manage'
import { db, PAYEE_ROLES, txnKind, type Payee, type PayeeRole, type Txn } from '../db/schema'
import { formatDate } from '../lib/date'

/** One payee's full ledger, split by property. */
export default function PayeeDetail() {
  const id = useParams().id ?? ''
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const payee = useLiveQuery(() => db.payees.get(id), [id])
  // Money paid to them: ordinary payments and repayments. Both carry payeeId.
  const paidTxns = useLiveQuery(
    () => db.txns.where('[payeeId+voided]').equals([id, 0]).toArray(),
    [id],
    [],
  )
  // Money they fronted on your behalf: on-behalf rows name them as fronterId.
  const frontedTxns = useLiveQuery(
    () => db.txns.where('fronterId').equals(id).filter((t) => t.voided === 0).toArray(),
    [id],
    [],
  )
  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.toArray(), [], [])
  const usage = useLiveQuery(() => payeeUsage(id), [id])
  const targets = useLiveQuery(() => payeeMergeTargets(id), [id], [])

  if (!payee) return <Screen title="Payee"><Empty title="Payee not found" /></Screen>

  const total = sum(paidTxns.map((t) => t.amount))
  const fronted = sum(frontedTxns.map((t) => t.amount))
  const repaid = sum(paidTxns.filter((t) => txnKind(t) === 'settlement').map((t) => t.amount))
  const owed = fronted - repaid

  // One timeline of every interaction, most recent first.
  const entries = [...paidTxns, ...frontedTxns].sort((a, b) => b.date.localeCompare(a.date))

  const byProject = projects
    .map((p) => ({ project: p, total: sum(paidTxns.filter((t) => t.projectId === p.id).map((t) => t.amount)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)

  const catName = (cid?: string) => categories.find((c) => c.id === cid)?.name ?? '—'
  const projName = (pid?: string) => projects.find((p) => p.id === pid)?.name ?? '—'
  const srcName = (sid?: string) => sources.find((s) => s.id === sid)?.name ?? '—'

  /** How one row reads, given its kind. */
  function describe(t: Txn): { title: string; sub: string } {
    const k = txnKind(t)
    if (k === 'onbehalf')
      return {
        title: `Fronted · ${catName(t.categoryId)}`,
        sub: `${formatDate(t.date)} · ${projName(t.projectId)}${t.note ? ` · ${t.note}` : ''}`,
      }
    if (k === 'settlement')
      return {
        title: 'Repayment',
        sub: `${formatDate(t.date)} · ${srcName(t.sourceId)}${t.note ? ` · ${t.note}` : ''}`,
      }
    return {
      title: catName(t.categoryId),
      sub: `${formatDate(t.date)} · ${projName(t.projectId)} · ${srcName(t.sourceId)}${t.note ? ` · ${t.note}` : ''}`,
    }
  }

  return (
    <Screen
      title={payee.name}
      action={
        <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel' : 'Edit'}
        </Button>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        {editing && (
          <EditPayeeForm
            payee={payee}
            onDone={(m) => {
              setEditing(false)
              setStatus(m)
              setError(null)
            }}
            onError={setError}
          />
        )}

        <Notice status={status} error={error} />

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Total paid" value={<Money paise={total} />} />
          {owed > 0 ? (
            <Stat label="You owe" value={<Money paise={owed} />} tone="text-out" />
          ) : (
            <Stat label="Payments" value={paidTxns.length} />
          )}
          <Stat label="Role" value={payee.role} />
        </div>

        {owed > 0 && (
          <Card className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                You owe {payee.name} <Money paise={owed} className="font-semibold" />
              </div>
              <div className="text-xs text-muted">
                Fronted <Money paise={fronted} /> · repaid <Money paise={repaid} />
              </div>
            </div>
            <Button
              onClick={() =>
                navigate('/add', {
                  state: { kind: 'settlement', payeeId: id, amount: (owed / 100).toString() },
                })
              }
            >
              Repay
            </Button>
          </Card>
        )}

        {payee.phone && (
          <a href={`tel:${payee.phone}`} className="block px-1 text-sm text-accent">
            Call {payee.phone}
          </a>
        )}

        {byProject.length > 1 && (
          <Card className="space-y-3 p-4">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">By property</h2>
            {byProject.map(({ project, total: t }) => (
              <div key={project.id} className="space-y-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="truncate">{project.name}</span>
                  <span className="tnum font-medium"><Money paise={t} /></span>
                </div>
                <Bar fraction={total ? t / total : 0} />
              </div>
            ))}
          </Card>
        )}

        {entries.length === 0 ? (
          <Empty title="Nothing recorded with this payee yet" />
        ) : (
          <Card className="divide-y divide-line">
            {entries.map((t) => {
              const { title, sub } = describe(t)
              const isFronted = txnKind(t) === 'onbehalf'
              return (
                <div key={t.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{title}</div>
                    <div className="truncate text-xs text-muted">{sub}</div>
                  </div>
                  <span className={`shrink-0 font-semibold ${isFronted ? 'text-muted' : ''}`}>
                    <Money paise={t.amount} />
                  </span>
                </div>
              )
            })}
          </Card>
        )}

        <ManagePanel
          noun="payee"
          name={payee.name}
          usage={usage}
          archived={Boolean(payee.archived)}
          onArchive={(next) => setPayeeArchived(id, next)}
          targets={targets.map((t) => ({ id: t.id, name: t.name, sub: t.role }))}
          mergePreview={(t) => (
            <>
              Move {usage?.txnCount ?? 0} payments from <strong>{payee.name}</strong> onto{' '}
              <strong>{t.name}</strong>, then delete <strong>{payee.name}</strong>. Use this when an
              import created the same person twice. This cannot be undone.
            </>
          )}
          onMerge={async (targetId) => {
            const r = await mergePayees(id, targetId)
            return `Merged: moved ${r.movedTxns} payments.`
          }}
          onDelete={() => deletePayee(id)}
          onDone={(m) => {
            setStatus(m)
            setError(null)
          }}
          onError={setError}
          onGone={() => navigate('/payees')}
        />

        <Link to="/payees" className="block px-1 text-sm text-accent">← All payees</Link>
      </div>
    </Screen>
  )
}

function EditPayeeForm({
  payee,
  onDone,
  onError,
}: {
  payee: Payee
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(payee.name)
  const [role, setRole] = useState<PayeeRole>(payee.role)
  const [phone, setPhone] = useState(payee.phone ?? '')
  const [notes, setNotes] = useState(payee.notes ?? '')

  async function save() {
    try {
      await updatePayee(payee.id, { name, role, phone, notes })
      onDone('Payee updated.')
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
        <Field label="Role" hint="Drives the role-wise breakdowns.">
          <Select value={role} onChange={(e) => setRole(e.target.value as PayeeRole)}>
            {PAYEE_ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Phone">
          <TextInput value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <Button onClick={() => void save()} disabled={!name.trim()}>
        Save changes
      </Button>
    </Card>
  )
}

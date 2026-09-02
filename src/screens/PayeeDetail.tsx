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
import { db, PAYEE_ROLES, type Payee, type PayeeRole } from '../db/schema'
import { formatDate } from '../lib/date'

/** One payee's full ledger, split by property. */
export default function PayeeDetail() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const payee = useLiveQuery(() => db.payees.get(id), [id])
  const txns = useLiveQuery(
    () => db.txns.where('[payeeId+voided]').equals([id, 0]).toArray(),
    [id],
    [],
  )
  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.toArray(), [], [])
  const usage = useLiveQuery(() => payeeUsage(id), [id])
  const targets = useLiveQuery(() => payeeMergeTargets(id), [id], [])

  if (!payee) return <Screen title="Payee"><Empty title="Payee not found" /></Screen>

  const total = sum(txns.map((t) => t.amount))
  const sorted = [...txns].sort((a, b) => b.date.localeCompare(a.date))

  const byProject = projects
    .map((p) => ({ project: p, total: sum(txns.filter((t) => t.projectId === p.id).map((t) => t.amount)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)

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
          <Stat label="Payments" value={txns.length} />
          <Stat label="Role" value={payee.role} />
        </div>

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

        {sorted.length === 0 ? (
          <Empty title="No payments recorded to this payee" />
        ) : (
          <Card className="divide-y divide-line">
            {sorted.map((t) => (
              <div key={t.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {categories.find((c) => c.id === t.categoryId)?.name ?? '—'}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {formatDate(t.date)} · {projects.find((p) => p.id === t.projectId)?.name ?? '—'} ·{' '}
                    {sources.find((s) => s.id === t.sourceId)?.name ?? '—'}
                    {t.note ? ` · ${t.note}` : ''}
                  </div>
                </div>
                <span className="shrink-0 font-semibold"><Money paise={t.amount} /></span>
              </div>
            ))}
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

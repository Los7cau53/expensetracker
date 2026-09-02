import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BackupNag } from '../components/BackupNag'
import { ManagePanel, Notice } from '../components/ManagePanel'
import { Bar, Button, Card, Empty, Field, Money, Screen, Select, Stat, TextInput } from '../components/ui'
import { projectSummary, sum, type ProjectSummary } from '../db/queries'
import {
  deleteProject,
  mergeProjects,
  projectMergeTargets,
  projectUsage,
  updateProject,
} from '../db/manage'
import { db, PROJECT_STATUSES, type Project, type ProjectStatus } from '../db/schema'
import { formatDate, formatMonth } from '../lib/date'
import { formatPaise, parseAmountToPaise } from '../lib/money'

export default function Projects() {
  const [adding, setAdding] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const summaries = useLiveQuery(async () => {
    const all = await db.projects.toArray()
    const rows = await Promise.all(all.map((p) => projectSummary(p.id)))
    return rows.filter((r): r is ProjectSummary => r !== null)
  }, [], [])

  const totalSpent = sum(summaries.map((s) => s.spent))

  return (
    <Screen
      title="Properties"
      action={
        <div className="flex gap-2">
          <Link to="/data" className="rounded-lg border border-line px-3 py-2.5 text-sm font-semibold">
            Data
          </Link>
          <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'New'}
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <BackupNag />

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Spent across all properties" value={<Money paise={totalSpent} />} />
          <Stat label="Properties" value={projects.length} />
        </div>

        {adding && <NewProjectForm onDone={() => setAdding(false)} />}

        <Notice status={status} error={error} />

        {summaries.length === 0 ? (
          <Empty title="No properties yet" />
        ) : (
          summaries.map((s) => (
            <ProjectCard
              key={s.project.id}
              summary={s}
              onDone={(m) => {
                setStatus(m)
                setError(null)
              }}
              onError={setError}
            />
          ))
        )}
      </div>
    </Screen>
  )
}

function ProjectCard({
  summary,
  onDone,
  onError,
}: {
  summary: ProjectSummary
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const { project, spent, txnCount, byCategory, bySource, byMonth, firstDate, lastDate } = summary
  const max = byCategory[0]?.total ?? 0
  const usage = useLiveQuery(() => projectUsage(project.id), [project.id])
  const targets = useLiveQuery(() => projectMergeTargets(project.id), [project.id], [])

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 text-left hover:bg-ground"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{project.name}</div>
            <div className="truncate text-xs text-muted">
              {project.status}
              {txnCount ? ` · ${txnCount} entries` : ' · nothing recorded'}
              {firstDate && lastDate ? ` · ${formatDate(firstDate)} to ${formatDate(lastDate)}` : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-semibold"><Money paise={spent} /></div>
            {project.budget ? (
              <div className="text-xs text-muted">
                of <Money paise={project.budget} />
              </div>
            ) : null}
          </div>
        </div>

        {project.budget ? (
          <div className="mt-2 space-y-1">
            <Bar fraction={spent / project.budget} />
            <div className="text-xs text-muted">
              {spent > project.budget ? (
                <span className="font-medium text-out">
                  Over budget by <Money paise={spent - project.budget} />
                </span>
              ) : (
                <>
                  <Money paise={project.budget - spent} /> left ·{' '}
                  {Math.round((spent / project.budget) * 100)}% used
                </>
              )}
            </div>
          </div>
        ) : null}
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-3">
          <Breakdown title="Where it went" rows={byCategory.map((c) => ({ label: c.name, total: c.total }))} max={max} />
          <Breakdown
            title="Which source paid"
            rows={bySource.map((s) => ({ label: s.name, total: s.total }))}
            max={bySource[0]?.total ?? 0}
          />
          <Breakdown
            title="By month"
            rows={byMonth.map((m) => ({ label: formatMonth(m.month), total: m.total }))}
            max={Math.max(0, ...byMonth.map((m) => m.total))}
          />
          <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cancel' : 'Edit property'}
          </Button>

          {editing && (
            <EditProjectForm
              project={project}
              onDone={(m) => {
                setEditing(false)
                onDone(m)
              }}
              onError={onError}
            />
          )}

          <ManagePanel
            noun="property"
            name={project.name}
            usage={usage}
            targets={targets.map((t) => ({ id: t.id, name: t.name, sub: t.status }))}
            mergePreview={(t) => (
              <>
                Move {usage?.txnCount ?? 0} payments and {usage?.fundInCount ?? 0} inflows from{' '}
                <strong>{project.name}</strong> onto <strong>{t.name}</strong>, then delete{' '}
                <strong>{project.name}</strong>.
                {project.budget
                  ? ` Budgets add up to ${formatPaise((project.budget ?? 0) + (targets.find((x) => x.id === t.id)?.budget ?? 0))}.`
                  : ''}{' '}
                This cannot be undone.
              </>
            )}
            onMerge={async (targetId) => {
              const r = await mergeProjects(project.id, targetId)
              return `Merged: moved ${r.movedTxns} payments and ${r.movedFundIns} inflows.`
            }}
            onDelete={() => deleteProject(project.id)}
            onDone={onDone}
            onError={onError}
            onGone={() => setOpen(false)}
          />

          <Link to="/ledger" className="block text-sm text-accent">Open in ledger →</Link>
        </div>
      )}
    </Card>
  )
}

function Breakdown({
  title,
  rows,
  max,
}: {
  title: string
  rows: { label: string; total: number }[]
  max: number
}) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {rows.map((r) => (
        <div key={r.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="tnum shrink-0 font-medium"><Money paise={r.total} /></span>
          </div>
          <Bar fraction={max ? r.total / max : 0} />
        </div>
      ))}
    </div>
  )
}

function EditProjectForm({
  project,
  onDone,
  onError,
}: {
  project: Project
  onDone: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(project.name)
  const [address, setAddress] = useState(project.address ?? '')
  const [projStatus, setProjStatus] = useState<ProjectStatus>(project.status)
  const [budget, setBudget] = useState(project.budget ? String(project.budget / 100) : '')

  async function save() {
    const paise = budget.trim() ? parseAmountToPaise(budget) : undefined
    if (budget.trim() && paise === null) {
      onError('Budget is not a valid amount.')
      return
    }
    try {
      await updateProject(project.id, {
        name,
        address,
        status: projStatus,
        budget: paise ?? undefined,
      })
      onDone('Property updated.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save.')
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Address">
        <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Select value={projStatus} onChange={(e) => setProjStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((st) => (
              <option key={st} value={st}>{st}</option>
            ))}
          </Select>
        </Field>
        <Field label="Budget" hint="Blank removes it.">
          <TextInput inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
      </div>
      <Button onClick={() => void save()} disabled={!name.trim()}>
        Save changes
      </Button>
    </Card>
  )
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [budget, setBudget] = useState('')

  async function create() {
    if (!name.trim()) return
    const paise = parseAmountToPaise(budget)
    await db.projects.add({
      name: name.trim(),
      address: address.trim() || undefined,
      status,
      budget: paise && paise > 0 ? paise : undefined,
      createdAt: Date.now(),
    } as never)
    onDone()
  }

  return (
    <Card className="space-y-3 p-4">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Plot 42, Kompally" />
      </Field>
      <Field label="Address">
        <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Budget">
          <TextInput inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
      <Button onClick={() => void create()} disabled={!name.trim()}>Add property</Button>
    </Card>
  )
}

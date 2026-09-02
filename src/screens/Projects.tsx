import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BackupNag } from '../components/BackupNag'
import { Bar, Button, Card, Empty, Field, Money, Screen, Select, Stat, TextInput } from '../components/ui'
import { projectSummary, sum, type ProjectSummary } from '../db/queries'
import { db, PROJECT_STATUSES, type ProjectStatus } from '../db/schema'
import { formatDate, formatMonth } from '../lib/date'
import { parseAmountToPaise } from '../lib/money'

export default function Projects() {
  const [adding, setAdding] = useState(false)

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

        {summaries.length === 0 ? (
          <Empty title="No properties yet" />
        ) : (
          summaries.map((s) => <ProjectCard key={s.project.id} summary={s} />)
        )}
      </div>
    </Screen>
  )
}

function ProjectCard({ summary }: { summary: ProjectSummary }) {
  const [open, setOpen] = useState(false)
  const { project, spent, txnCount, byCategory, bySource, byMonth, firstDate, lastDate } = summary
  const max = byCategory[0]?.total ?? 0

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
          <BudgetEditor projectId={project.id} current={project.budget} />
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

function BudgetEditor({ projectId, current }: { projectId: number; current?: number }) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)

  async function save() {
    const paise = parseAmountToPaise(value)
    await db.projects.update(projectId, { budget: paise && paise > 0 ? paise : undefined })
    setOpen(false)
    setValue('')
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-accent">
        {current ? 'Change budget' : 'Set a budget'}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <Field label="Budget" hint="Leave blank to remove it.">
        <TextInput inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
      <div className="flex gap-2">
        <Button onClick={() => void save()}>Save</Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
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

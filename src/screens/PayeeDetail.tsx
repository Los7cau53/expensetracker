import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { Bar, Card, Empty, Money, Screen, Stat } from '../components/ui'
import { sum } from '../db/queries'
import { db } from '../db/schema'
import { formatDate } from '../lib/date'

/** One payee's full ledger, split by property. */
export default function PayeeDetail() {
  const id = Number(useParams().id)

  const payee = useLiveQuery(() => db.payees.get(id), [id])
  const txns = useLiveQuery(
    () => db.txns.where('[payeeId+voided]').equals([id, 0]).toArray(),
    [id],
    [],
  )
  const projects = useLiveQuery(() => db.projects.toArray(), [], [])
  const categories = useLiveQuery(() => db.categories.toArray(), [], [])
  const sources = useLiveQuery(() => db.sources.toArray(), [], [])

  if (!payee) return <Screen title="Payee"><Empty title="Payee not found" /></Screen>

  const total = sum(txns.map((t) => t.amount))
  const sorted = [...txns].sort((a, b) => b.date.localeCompare(a.date))

  const byProject = projects
    .map((p) => ({ project: p, total: sum(txns.filter((t) => t.projectId === p.id).map((t) => t.amount)) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)

  return (
    <Screen title={payee.name}>
      <div className="mx-auto max-w-2xl space-y-4">
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

        <Link to="/payees" className="block px-1 text-sm text-accent">← All payees</Link>
      </div>
    </Screen>
  )
}

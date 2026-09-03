import type { ReactNode } from 'react'
import { formatPaise } from '../lib/money'

export function Screen({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh pb-24">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {action}
      </header>
      <main className="px-4 py-4">{children}</main>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>{children}</section>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

/**
 * A caption above a group of controls, for composite widgets.
 *
 * `Field` wraps its children in a `<label>`, which is right for a single
 * input and wrong for anything with buttons inside: the caption bleeds into
 * every descendant's accessible name, so a combo box's "Change" button
 * announced itself as "Paid from Cash in hand". A label must wrap one control.
 */
export function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1 block text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  )
}

const controlClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${controlClass} ${props.className ?? ''}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${controlClass} ${props.className ?? ''}`} />
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
}) {
  const styles = {
    primary: 'bg-accent text-white hover:brightness-110',
    secondary: 'border border-line bg-surface hover:bg-ground',
    danger: 'border border-out/30 bg-surface text-out hover:bg-out/5',
    ghost: 'text-accent hover:underline',
  }[variant]
  return (
    <button
      {...props}
      className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:opacity-40 ${styles} ${className}`}
    />
  )
}

/** Money always renders tabular so columns of figures line up. */
export function Money({
  paise,
  className = '',
  signed = false,
}: {
  paise: number
  className?: string
  signed?: boolean
}) {
  const tone = !signed ? '' : paise < 0 ? 'text-out' : 'text-in'
  // Never wrap: a break between the minus sign and the digits turns
  // "-₹35,000.00" into a dash above a positive-looking figure.
  return (
    <span className={`tnum whitespace-nowrap ${tone} ${className}`}>{formatPaise(paise)}</span>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
      <p className="font-medium text-muted">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-xs text-sm text-muted">{hint}</p>}
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-base font-semibold ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

/** Horizontal proportion bar used in the category / source breakdowns. */
export function Bar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ground">
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  )
}

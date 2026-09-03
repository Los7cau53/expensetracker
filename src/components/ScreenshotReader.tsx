import { useEffect, useRef, useState } from 'react'
import { Button, Card, Field } from './ui'
import { mergeReceipt, parseGpayFilename, parseGpayText, type ReceiptFields } from '../lib/gpay'
import { formatPaise } from '../lib/money'
import { formatDate } from '../lib/date'

/**
 * Reads a Google Pay receipt and hands the fields up to be edited.
 *
 * Two passes, because the filename is exact and instant while OCR is a guess
 * that takes a second: the name is parsed on selection and applied straight
 * away, then OCR fills in the bank and the UPI reference, which only exist
 * inside the image.
 *
 * On iPhone this is a picker rather than a share sheet. iOS Safari does not
 * implement Web Share Target, so an installed PWA cannot be a share
 * destination — pick the screenshot from Photos, or paste it.
 */
export function ScreenshotReader({
  onExtract,
  onClose,
}: {
  onExtract: (fields: ReceiptFields) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [fields, setFields] = useState<ReceiptFields | null>(null)
  const [rawText, setRawText] = useState('')
  const [confidence, setConfidence] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Pasting a screenshot is the quickest route on a phone.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) {
        e.preventDefault()
        void read(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  async function read(file: File) {
    setError(null)
    setConfidence(null)
    setRawText('')
    setProgress(0)

    // The filename is exact data, so apply it before the slow part starts.
    const fromName = parseGpayFilename(file.name)
    if (fromName.amount || fromName.payee) {
      setFields(fromName)
      onExtract(fromName)
    }

    setBusy(true)
    try {
      const { readImageText } = await import('../lib/ocr')
      const { text, confidence: conf } = await readImageText(file, setProgress)
      setRawText(text)
      setConfidence(conf)

      const merged = mergeReceipt(fromName, parseGpayText(text))
      setFields(merged)
      onExtract(merged)
    } catch (e) {
      // A failed read must not discard what the filename already gave us.
      setError(
        e instanceof Error
          ? `Could not read the image (${e.message}). Anything the filename gave is still filled in.`
          : 'Could not read the image.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Read a payment screenshot</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted">
          Close
        </button>
      </div>

      <Field
        label="Screenshot"
        hint="Pick a Google Pay screenshot from Photos, or paste one. It is read on this device and never uploaded."
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void read(f)
          }}
          className="w-full text-sm"
        />
      </Field>

      {busy && (
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ground">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {progress < 0.5
              ? 'Loading the reader (first time only, then it works offline)…'
              : 'Reading the screenshot…'}
          </p>
        </div>
      )}

      {error && <p className="rounded-lg bg-out/10 px-3 py-2 text-sm text-out">{error}</p>}

      {fields && (
        <div className="space-y-2">
          {fields.status === 'failed' && (
            <p className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">
              This receipt says the payment <strong>failed</strong>. Money did not leave the
              account, so it probably should not be recorded.
            </p>
          )}
          {fields.status === 'pending' && (
            <p className="rounded-lg bg-out/5 px-3 py-2 text-sm">
              This payment is still <strong>pending</strong>. Check it went through before relying
              on the balance.
            </p>
          )}
          {fields.direction === 'in' && (
            <p className="rounded-lg bg-in/10 px-3 py-2 text-sm">
              This looks like money <strong>received</strong>, not spent. Record it as funds in on
              the source instead, or change the amount here if it really was a payment out.
            </p>
          )}

          <dl className="divide-y divide-line rounded-lg border border-line">
            <Row label="Amount" value={fields.amount ? formatPaise(fields.amount) : undefined} src={fields.from.amount} />
            <Row label="Date" value={fields.date ? formatDate(fields.date) : undefined} src={fields.from.date} />
            <Row label="Paid to" value={fields.payee} src={fields.from.payee} />
            <Row label="Account name" value={fields.payeeAccountName} src={fields.from.payeeAccountName} />
            <Row
              label="Paid from"
              value={[fields.bank, fields.bankLast4].filter(Boolean).join(' ') || undefined}
              src={fields.from.bank ?? fields.from.bankLast4}
            />
            <Row label="Reference" value={fields.reference} src={fields.from.reference} />
          </dl>

          <p className="text-xs text-muted">
            Everything above has been filled into the form below — check it and change whatever is
            wrong before saving.
            {confidence !== null && confidence < 70
              ? ` The image read poorly (${Math.round(confidence)}% confidence), so check the amount especially.`
              : ''}
          </p>

          {rawText && (
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted">
                What the reader saw
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted">
                {rawText}
              </pre>
            </details>
          )}
        </div>
      )}

      {!busy && !fields && (
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          Choose a screenshot
        </Button>
      )}
    </Card>
  )
}

function Row({
  label,
  value,
  src,
}: {
  label: string
  value?: string
  src?: 'filename' | 'ocr'
}) {
  if (!value) return null
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex items-baseline gap-2 text-sm font-medium">
        <span className="tnum">{value}</span>
        <span className="text-[10px] font-normal text-muted">
          {src === 'filename' ? 'from file name' : 'from image'}
        </span>
      </dd>
    </div>
  )
}

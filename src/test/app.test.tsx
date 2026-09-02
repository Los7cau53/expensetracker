// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashRouter } from 'react-router-dom'
import App from '../App'
import { db } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import { sourceBalances } from '../db/queries'

async function freshDb() {
  await Promise.all([
    db.projects.clear(),
    db.sources.clear(),
    db.payees.clear(),
    db.categories.clear(),
    db.txns.clear(),
    db.fundIns.clear(),
    db.importBatches.clear(),
    db.settings.clear(),
  ])
  await seedIfEmpty()
}

function renderApp(route = '/') {
  window.location.hash = `#${route}`
  return render(
    <HashRouter>
      <App />
    </HashRouter>,
  )
}

beforeEach(freshDb)
afterEach(cleanup)

describe('app shell', () => {
  it('lands on the summary dashboard', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeTruthy()
  })

  it('renders the properties dashboard with the seeded property', async () => {
    renderApp('/properties')
    expect(await screen.findByRole('heading', { name: 'Properties' })).toBeTruthy()
    expect(await screen.findByText('My first property')).toBeTruthy()
  })

  it('renders every tab without crashing', async () => {
    for (const [route, heading] of [
      ['/', 'Summary'],
      ['/properties', 'Properties'],
      ['/ledger', 'Ledger'],
      ['/add', 'Add payment'],
      ['/sources', 'Fund sources'],
      ['/payees', 'Paid to'],
      ['/data', 'Data & backup'],
    ] as const) {
      renderApp(route)
      expect(await screen.findByRole('heading', { name: heading })).toBeTruthy()
      cleanup()
    }
  })
})

describe('recording a payment end to end', () => {
  it('saves it and moves the source balance by exactly that amount', async () => {
    const user = userEvent.setup()

    // Give the seeded cash source some money so the balance is meaningful.
    const cash = (await db.sources.toArray())[0]
    await db.fundIns.add({
      date: '2026-01-01',
      sourceId: cash.id,
      amount: 1_00_000_00,
      origin: 'Own savings',
      createdAt: Date.now(),
    } as never)

    const before = (await sourceBalances()).find((b) => b.source.id === cash.id)!.balance
    expect(before).toBe(1_00_000_00)

    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.type(screen.getByLabelText('Amount in rupees'), '4500.50')

    // Create the payee inline, the way it happens at a site.
    const payeeBox = screen.getByPlaceholderText('Mestri, electrician, supplier…')
    await user.type(payeeBox, 'Ramesh mestri')
    await user.click(await screen.findByText(/Add “Ramesh mestri”/))

    // Pick a cost head.
    const categoryBox = screen.getByPlaceholderText('Permissions, masonry, cement…')
    await user.type(categoryBox, 'Masonry')
    await user.click(await screen.findByRole('button', { name: 'Masonry' }))

    await user.click(screen.getByRole('button', { name: /Save & add another/ }))

    await waitFor(async () => {
      expect(await db.txns.count()).toBe(1)
    })

    const txn = (await db.txns.toArray())[0]
    expect(txn.amount).toBe(4_500_50)
    expect(txn.voided).toBe(0)

    const after = (await sourceBalances()).find((b) => b.source.id === cash.id)!.balance
    expect(before - after).toBe(4_500_50)

    // The payee was created with the name as typed.
    const payees = await db.payees.toArray()
    expect(payees.map((p) => p.name)).toEqual(['Ramesh mestri'])
  })

  it('refuses to save without an amount', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    const save = screen.getByRole('button', { name: /^Save$/ })
    expect(save.hasAttribute('disabled')).toBe(true)

    await user.type(screen.getByLabelText('Amount in rupees'), 'abc')
    expect(await screen.findByText('Not a valid amount.')).toBeTruthy()
    expect(await db.txns.count()).toBe(0)
  })
})

describe('backup nag', () => {
  it('appears once there is data and no backup', async () => {
    const [project, source, category] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    await db.txns.add({
      date: '2026-02-01',
      projectId: project[0].id,
      amount: 1_000_00,
      sourceId: source[0].id,
      categoryId: category[0].id,
      voided: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    renderApp('/')
    expect(await screen.findByText('No backup yet')).toBeTruthy()
  })

  it('stays hidden when there is nothing to lose', async () => {
    renderApp('/')
    await screen.findByRole('heading', { name: 'Summary' })
    expect(screen.queryByText('No backup yet')).toBeNull()
  })
})

describe('ledger', () => {
  it('lists a payment with its payee, month header and total', async () => {
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    const payeeId = (await db.payees.add({
      name: 'Suresh electrical',
      role: 'electrician',
      archived: 0,
      createdAt: Date.now(),
    } as never)) as number

    await db.txns.add({
      date: '2026-02-14',
      projectId: projects[0].id,
      amount: 12_500_00,
      sourceId: sources[0].id,
      payeeId,
      categoryId: categories[0].id,
      voided: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })

    expect(await screen.findByText('Suresh electrical')).toBeTruthy()
    expect(await screen.findByText('Feb 2026')).toBeTruthy()
    expect((await screen.findAllByText('₹12,500.00')).length).toBeGreaterThan(0)
  })

  it('voids an entry from the row editor and keeps it visible as voided', async () => {
    const user = userEvent.setup()
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    const id = (await db.txns.add({
      date: '2026-02-14',
      projectId: projects[0].id,
      amount: 9_000_00,
      sourceId: sources[0].id,
      categoryId: categories[0].id,
      voided: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)) as number

    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })

    // With no payee, the row is labelled by its cost head.
    await user.click(await screen.findByText('Land & registration'))
    await user.click(await screen.findByRole('button', { name: 'Void' }))

    await waitFor(async () => {
      expect((await db.txns.get(id))!.voided).toBe(1)
    })

    // Amount is preserved for a later dispute, not deleted.
    expect((await db.txns.get(id))!.amount).toBe(9_000_00)

    // Default view excludes it from the total.
    const header = await screen.findByText(/0 entries|1 entry/)
    expect(within(header.parentElement!).getByText('₹0.00')).toBeTruthy()
  })
})

describe('sources', () => {
  it('shows a balance that follows opening + in - out', async () => {
    const source = (await db.sources.toArray())[0]
    await db.sources.update(source.id, { openingBalance: 25_000_00 })
    await db.fundIns.add({
      date: '2026-01-01',
      sourceId: source.id,
      amount: 75_000_00,
      origin: 'Loan tranche',
      createdAt: Date.now(),
    } as never)

    renderApp('/sources')
    await screen.findByRole('heading', { name: 'Fund sources' })

    // ₹25,000 opening + ₹75,000 in, nothing out.
    expect((await screen.findAllByText('₹1,00,000.00')).length).toBeGreaterThan(0)
  })
})

describe('fixing up imported rows by hand', () => {
  /** Imported history arrives with no payee and a fallback source. */
  async function importedRow() {
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    const realSource = (await db.sources.add({
      name: 'SBI net banking',
      type: 'bank',
      openingBalance: 0,
      archived: 0,
      createdAt: Date.now(),
    } as never)) as number

    const id = (await db.txns.add({
      date: '2026-02-20',
      projectId: projects[0].id,
      amount: 70_000_00,
      sourceId: sources[0].id,
      categoryId: categories[0].id,
      note: 'cash agreement',
      importBatchId: 1,
      voided: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)) as number

    return { id, realSource, fallbackSource: sources[0].id }
  }

  it('labels a payee-less row by its note so the list stays scannable', async () => {
    await importedRow()
    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })

    expect(await screen.findByText('cash agreement')).toBeTruthy()
    expect(await screen.findByText(/no payee/)).toBeTruthy()
  })

  it('assigns a payee and a real source to an imported row', async () => {
    const user = userEvent.setup()
    const { id, realSource } = await importedRow()

    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })
    await user.click(await screen.findByText('cash agreement'))

    // Create the payee inline, from inside the ledger.
    const payeeBox = await screen.findByPlaceholderText('Mestri, electrician, supplier…')
    await user.type(payeeBox, 'Somnath Reddy')
    await user.click(await screen.findByText(/Add “Somnath Reddy”/))

    // Move it off the fallback source onto the account that really paid.
    const sourceSelect = screen.getByLabelText(/Paid from/i)
    await user.selectOptions(sourceSelect, String(realSource))

    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => {
      const row = (await db.txns.get(id))!
      expect(row.payeeId).toBeDefined()
      expect(row.sourceId).toBe(realSource)
    })

    // The amount was never touched by the reassignment.
    expect((await db.txns.get(id))!.amount).toBe(70_000_00)
    const payee = await db.payees.where('name').equals('Somnath Reddy').first()
    expect(payee!.role).toBe('other')
  })

  it('leaves Save disabled until something actually changes', async () => {
    const user = userEvent.setup()
    await importedRow()
    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })
    await user.click(await screen.findByText('cash agreement'))

    const save = await screen.findByRole('button', { name: 'Save changes' })
    expect(save.hasAttribute('disabled')).toBe(true)
  })
})

describe('getting a backup into Google Drive', () => {
  const nav = navigator as unknown as {
    canShare?: (d: unknown) => boolean
    share?: (d: unknown) => Promise<void>
  }
  const win = window as unknown as { showSaveFilePicker?: unknown }

  afterEach(() => {
    delete nav.canShare
    delete nav.share
    delete win.showSaveFilePicker
  })

  it('offers the synced-folder route where a file picker exists', async () => {
    win.showSaveFilePicker = () => Promise.reject(new Error('not called'))

    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })

    expect(await screen.findByText('Keep a copy in Google Drive')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Choose a file in Drive' })).toBeTruthy()
    expect(await screen.findByText(/Google Drive › My Drive/)).toBeTruthy()
    // The phone route must not also be offered on a desktop.
    expect(screen.queryByRole('button', { name: 'Share backup' })).toBeNull()
  })

  it('offers the share sheet on a phone, and hands over a real file', async () => {
    const user = userEvent.setup()
    const shared: { files: File[] }[] = []
    nav.canShare = () => true
    nav.share = async (d) => {
      shared.push(d as { files: File[] })
    }

    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })

    const button = await screen.findByRole('button', { name: 'Share backup' })
    // Disabled until the snapshot is ready, since the handler cannot await one.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    await user.click(button)

    await waitFor(() => expect(shared).toHaveLength(1))
    expect(shared[0].files[0].name).toMatch(/^construction-expenses-.*\.json$/)
    expect(await screen.findByText('Backup shared.')).toBeTruthy()

    // Sharing counts as a backup, so the nag stands down.
    await waitFor(async () => {
      expect(typeof (await db.settings.get('lastBackupAt'))?.value).toBe('number')
    })
  })

  it('says so plainly when neither route is available', async () => {
    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })

    expect(
      await screen.findByText(/neither a file picker nor a share sheet/),
    ).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Export backup (JSON)' })).toBeTruthy()
  })

  it('keeps the restorable JSON distinct from the read-only CSV', async () => {
    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })
    expect(await screen.findByText(/CSV is for reading in a spreadsheet/)).toBeTruthy()
  })
})

describe('backup card urgency', () => {
  it('does not alarm on a fresh install with nothing recorded', async () => {
    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })

    expect(await screen.findByText(/Nothing recorded yet, so nothing to back up/)).toBeTruthy()
    expect(screen.queryByText(/never taken a backup/)).toBeNull()
  })

  it('warns once there is data and no backup', async () => {
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    await db.txns.add({
      date: '2026-03-01', amount: 1_000_00, projectId: projects[0].id,
      sourceId: sources[0].id, categoryId: categories[0].id,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    renderApp('/data')
    await screen.findByRole('heading', { name: 'Data & backup' })
    expect(await screen.findByText(/You have never taken a backup/)).toBeTruthy()
  })
})

describe('negative money rendering', () => {
  it('never breaks between the minus sign and the digits', async () => {
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    // An overdrawn source: opening 0, one payment out.
    await db.txns.add({
      date: '2026-03-01', amount: 35_000_00, projectId: projects[0].id,
      sourceId: sources[0].id, categoryId: categories[0].id,
      voided: 0, createdAt: 1, updatedAt: 1,
    } as never)

    renderApp(`/sources/${sources[0].id}`)
    await screen.findByRole('heading', { name: 'Cash in hand' })

    const negative = await screen.findByText('-₹35,000.00')
    // A wrapped minus sign reads as a dash above a positive figure.
    expect(negative.className).toContain('whitespace-nowrap')
  })
})

describe('creating a source', () => {
  it('infers the type from the name, the way the importer does', async () => {
    const user = userEvent.setup()
    renderApp('/sources')
    await screen.findByRole('heading', { name: 'Fund sources' })

    await user.click(screen.getByRole('button', { name: 'New source' }))
    await user.type(await screen.findByPlaceholderText('SBI savings · 4471'), 'GPay')

    // Left as the default "bank", a UPI wallet lands in the wrong bucket in
    // every report that groups by type.
    const select = screen.getByLabelText(/Type/i) as HTMLSelectElement
    expect(select.value).toBe('upi')

    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await waitFor(async () => {
      const created = await db.sources.where('name').equals('GPay').first()
      expect(created?.type).toBe('upi')
    })
  })

  it('lets an explicit choice win over the guess', async () => {
    const user = userEvent.setup()
    renderApp('/sources')
    await screen.findByRole('heading', { name: 'Fund sources' })

    await user.click(screen.getByRole('button', { name: 'New source' }))
    await user.type(await screen.findByPlaceholderText('SBI savings · 4471'), 'GPay')
    await user.selectOptions(screen.getByLabelText(/Type/i), 'card')
    await user.click(screen.getByRole('button', { name: 'Add source' }))

    await waitFor(async () => {
      expect((await db.sources.where('name').equals('GPay').first())?.type).toBe('card')
    })
  })

  it('signals that each row opens a screen where it can be renamed', async () => {
    renderApp('/sources')
    await screen.findByRole('heading', { name: 'Fund sources' })
    // The rename lives one tap deeper; without this the screen reads read-only.
    expect(await screen.findByText(/Tap a source to rename it/)).toBeTruthy()
  })
})

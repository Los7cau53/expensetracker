// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashRouter } from 'react-router-dom'
import App from '../App'
import { db } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import { sourceBalances, type TxnFilter } from '../db/queries'
import { readPref } from '../lib/prefs'

async function freshDb() {
  localStorage.clear()
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
      ['/settings', 'Settings'],
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

describe('recording a payment made on my behalf', () => {
  it('records both who paid and who received the money', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.click(screen.getByRole('button', { name: 'Paid on my behalf' }))
    await user.type(screen.getByLabelText('Amount in rupees'), '5000')

    const paidBy = within(screen.getByRole('group', { name: 'Paid by' }))
    await user.type(paidBy.getByPlaceholderText('Mestri, partner, relative…'), 'Partner X')
    await user.click(await paidBy.findByText(/Add “Partner X”/))

    const paidTo = within(screen.getByRole('group', { name: 'Paid to' }))
    await user.type(paidTo.getByPlaceholderText('Mestri, electrician, supplier…'), 'Borewell Contractor')
    await user.click(await paidTo.findByText(/Add “Borewell Contractor”/))

    const category = within(screen.getByRole('group', { name: 'For what' }))
    const categoryBox = category.queryByPlaceholderText('Permissions, masonry, cement…')
    if (categoryBox) {
      await user.type(categoryBox, 'Borewell')
      await user.click(await category.findByRole('button', { name: /Add “Borewell”/ }))
    }
    await user.click(screen.getByRole('button', { name: /Save & add another/ }))

    await waitFor(async () => expect(await db.txns.count()).toBe(1))
    const txn = (await db.txns.toArray())[0]
    const payees = await db.payees.toArray()
    expect(payees.find((p) => p.id === txn.fronterId)?.name).toBe('Partner X')
    expect(payees.find((p) => p.id === txn.payeeId)?.name).toBe('Borewell Contractor')
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

describe('summary drill-down', () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 600 })
  })

  afterEach(() => {
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  })

  it('opens the ledger filtered to the selected cost head', async () => {
    const user = userEvent.setup()
    const [project, source, categories] = await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.categories.toArray(),
    ])
    const now = Date.now()
    await db.txns.bulkAdd([
      {
        date: '2026-08-01', projectId: project[0].id, sourceId: source[0].id,
        categoryId: categories[0].id, amount: 1_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
      {
        date: '2026-08-02', projectId: project[0].id, sourceId: source[0].id,
        categoryId: categories[1].id, amount: 2_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
    ] as never)

    renderApp('/')
    const heading = await screen.findByText('Where it went')
    const card = within(heading.closest('section')!)
    await user.click(card.getByRole('button', { name: new RegExp(categories[0].name) }))

    expect(await screen.findByRole('heading', { name: 'Ledger' })).toBeTruthy()
    expect(await screen.findByText('1 entry')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Filter (1)' }))
    expect((screen.getByRole('combobox', { name: 'For what' }) as HTMLSelectElement).value)
      .toBe(categories[0].id)
  })

  it('opens the ledger for the selected month', async () => {
    const user = userEvent.setup()
    const [project, source, category] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    const now = Date.now()
    await db.txns.bulkAdd([
      {
        date: '2026-08-10', projectId: project[0].id, sourceId: source[0].id,
        categoryId: category[0].id, amount: 1_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
      {
        date: '2026-09-10', projectId: project[0].id, sourceId: source[0].id,
        categoryId: category[0].id, amount: 2_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
    ] as never)

    renderApp('/')
    const heading = await screen.findByText('By month')
    await user.click(within(heading.closest('section')!).getByRole('button', { name: /Aug:/ }))

    expect(await screen.findByText('1 entry')).toBeTruthy()
    expect(readPref<TxnFilter>('ledgerFilter', {})).toMatchObject({
      from: '2026-08-01', to: '2026-08-31',
    })
  })

  it('opens the ledger filtered to the selected funding source', async () => {
    const user = userEvent.setup()
    const [project, sources, category] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    const bank = (await db.sources.add({
      name: 'SBI', type: 'bank', openingBalance: 0, archived: 0, createdAt: Date.now(),
    } as never)) as string
    const now = Date.now()
    await db.txns.bulkAdd([
      {
        date: '2026-08-10', projectId: project[0].id, sourceId: sources[0].id,
        categoryId: category[0].id, amount: 1_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
      {
        date: '2026-08-11', projectId: project[0].id, sourceId: bank,
        categoryId: category[0].id, amount: 2_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
    ] as never)

    renderApp('/')
    const heading = await screen.findByText('Which source paid')
    await user.click(within(heading.closest('section')!).getByRole('button', { name: /SBI:/ }))

    expect(await screen.findByText('1 entry')).toBeTruthy()
    expect(readPref<TxnFilter>('ledgerFilter', {})).toMatchObject({ sourceId: bank, kind: 'expense' })
  })

  it('opens the ledger for the selected timeline day', async () => {
    const user = userEvent.setup()
    const [project, source, category] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    const now = Date.now()
    await db.txns.bulkAdd([
      {
        date: '2026-08-10', projectId: project[0].id, sourceId: source[0].id,
        categoryId: category[0].id, amount: 1_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
      {
        date: '2026-08-11', projectId: project[0].id, sourceId: source[0].id,
        categoryId: category[0].id, amount: 2_000_00, voided: 0, createdAt: now, updatedAt: now,
      },
    ] as never)

    renderApp('/')
    const heading = await screen.findByText('Spend over time')
    await user.click(within(heading.closest('section')!).getByRole('button', { name: /Cumulative spend/ }))

    expect(await screen.findByText('1 entry')).toBeTruthy()
    expect(readPref<TxnFilter>('ledgerFilter', {})).toMatchObject({
      from: '2026-08-10', to: '2026-08-10',
    })
  })

  it('expands Other to show every cost head', async () => {
    const user = userEvent.setup()
    const [project, source, categories] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    const now = Date.now()
    await db.txns.bulkAdd(categories.slice(0, 9).map((category, index) => ({
      date: '2026-08-10', projectId: project[0].id, sourceId: source[0].id,
      categoryId: category.id, amount: (index + 1) * 100_00, voided: 0,
      createdAt: now, updatedAt: now,
    })) as never)

    renderApp('/')
    const heading = await screen.findByText('Where it went')
    const card = within(heading.closest('section')!)
    expect(card.queryByRole('button', { name: new RegExp(categories[0].name) })).toBeNull()
    await user.click(card.getByRole('button', { name: /Other \(2\)/ }))

    expect(await card.findByRole('button', { name: new RegExp(categories[0].name) })).toBeTruthy()
    expect(card.queryByRole('button', { name: /Other \(2\)/ })).toBeNull()
  })

  it('keeps cost-head navigation working in Numbers mode', async () => {
    const user = userEvent.setup()
    const [project, source, category] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    await db.txns.add({
      date: '2026-08-10', projectId: project[0].id, sourceId: source[0].id,
      categoryId: category[0].id, amount: 1_000_00, voided: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as never)

    renderApp('/')
    const heading = await screen.findByText('Where it went')
    const card = within(heading.closest('section')!)
    await user.click(card.getByRole('button', { name: 'Numbers' }))
    await user.click(card.getByRole('row', { name: new RegExp(category[0].name) }))

    expect(await screen.findByRole('heading', { name: 'Ledger' })).toBeTruthy()
    expect(readPref<TxnFilter>('ledgerFilter', {})).toMatchObject({ categoryId: category[0].id })
  })

  it('expands Other to show every funding source', async () => {
    const user = userEvent.setup()
    const [project, category] = await Promise.all([db.projects.toArray(), db.categories.toArray()])
    await db.sources.bulkAdd(Array.from({ length: 6 }, (_, index) => ({
      name: `Bank ${index + 1}`, type: 'bank', openingBalance: 0, archived: 0, createdAt: Date.now(),
    })) as never)
    const sources = await db.sources.toArray()
    const now = Date.now()
    await db.txns.bulkAdd(sources.map((source, index) => ({
      date: '2026-08-10', projectId: project[0].id, sourceId: source.id,
      categoryId: category[0].id, amount: (index + 1) * 100_00, voided: 0,
      createdAt: now, updatedAt: now,
    })) as never)

    renderApp('/')
    const heading = await screen.findByText('Which source paid')
    const card = within(heading.closest('section')!)
    const smallest = sources[0].name
    expect(card.queryByRole('button', { name: new RegExp(`${smallest}:`) })).toBeNull()
    await user.click(card.getByRole('button', { name: /Other \(2\)/ }))

    expect(await card.findByRole('button', { name: new RegExp(`${smallest}:`) })).toBeTruthy()
    expect(card.queryByRole('button', { name: /Other \(2\)/ })).toBeNull()
  })

  it('opens the selected recipient’s payee page', async () => {
    const user = userEvent.setup()
    const [project, source, category] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    const payeeId = (await db.payees.add({
      name: 'Ramesh Mestri', role: 'mestri', archived: 0, createdAt: Date.now(),
    } as never)) as string
    await db.txns.add({
      date: '2026-08-10', projectId: project[0].id, sourceId: source[0].id,
      categoryId: category[0].id, payeeId, amount: 1_000_00, voided: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as never)

    renderApp('/')
    const heading = await screen.findByRole('heading', { name: 'Paid to', level: 2 })
    await user.click(within(heading.closest('section')!).getByRole('button', { name: /Ramesh Mestri/ }))

    expect(await screen.findByRole('heading', { name: 'Ramesh Mestri', level: 1 })).toBeTruthy()
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
    } as never)) as string

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
    } as never)) as string

    renderApp('/ledger')
    await screen.findByRole('heading', { name: 'Ledger' })

    // With no payee, the row is labelled by its cost head. Named explicitly:
    // UUID keys mean toArray() has no meaningful order, so "the first
    // category" is no longer a thing a test can rely on.
    const costHead = (await db.categories.get(
      (await db.txns.toArray())[0].categoryId!,
    ))!.name
    await user.click(await screen.findByText(costHead))
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
    } as never)) as string

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
    } as never)) as string

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

    // Move it off the fallback source onto the account that really paid. It is
    // a searchable, creatable picker now rather than a plain select.
    // Scoped to the field: payee, cost head, source and property each render
    // their own collapsed picker with a "Change" button.
    const paidFrom = within(screen.getByRole('group', { name: 'Paid from' }))
    await user.click(paidFrom.getByRole('button', { name: 'Change' }))
    await user.type(paidFrom.getByPlaceholderText('Cash, SBI, GPay…'), 'SBI net banking')
    await user.click(await paidFrom.findByRole('button', { name: /SBI net banking/ }))

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

    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

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

    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

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
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

    expect(
      await screen.findByText(/neither a file picker nor a share sheet/),
    ).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Export backup (JSON)' })).toBeTruthy()
  })

  it('keeps the restorable JSON distinct from the read-only CSV', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })
    expect(await screen.findByText(/CSV is for reading in a spreadsheet/)).toBeTruthy()
  })
})

describe('backup card urgency', () => {
  it('does not alarm on a fresh install with nothing recorded', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

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

    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })
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

describe('creating a payee role', () => {
  it('adds a custom role while creating a payee', async () => {
    const user = userEvent.setup()
    renderApp('/payees')
    await screen.findByRole('heading', { name: 'Paid to' })

    await user.click(screen.getByRole('button', { name: 'New payee' }))
    await user.type(await screen.findByPlaceholderText('Ramesh mestri'), 'Ravi')

    const role = within(screen.getByRole('group', { name: 'Role' }))
    await user.click(role.getByRole('button', { name: 'Change' }))
    await user.type(role.getByPlaceholderText('Pick or add a role…'), 'roofer')
    await user.click(await role.findByRole('button', { name: /Add “roofer”/ }))
    await user.click(screen.getByRole('button', { name: 'Add payee' }))

    await waitFor(async () => {
      expect((await db.payees.where('name').equals('Ravi').first())?.role).toBe('roofer')
    })
    expect(await screen.findByRole('option', { name: 'roofer' })).toBeTruthy()
  })
})

describe('finding the customisation screens', () => {
  it('puts them at the top of Settings, not buried under backup', async () => {
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

    // The complaint that prompted this: cost heads lived several panels down
    // inside a screen called "Data & backup".
    const heading = await screen.findByText('Customise')
    // Scoped to the card: "Payees" and "Sources" also name bottom tabs.
    const card = within(heading.closest('section')!)
    for (const label of ['Cost heads', 'Properties', 'Fund sources', 'Payees']) {
      expect(card.getByText(label)).toBeTruthy()
    }
    expect(card.getByText('Cost heads').closest('a')).toHaveProperty('href')
  })

  it('keeps the old /data path working for existing links', async () => {
    renderApp('/data')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
  })

  it('reaches Properties from Summary, since it left the tab bar', async () => {
    renderApp('/')
    await screen.findByRole('heading', { name: 'Summary' })
    // With no entries the dashboard shows its empty state, so seed one.
    const [projects, sources, categories] = await Promise.all([
      db.projects.toArray(), db.sources.toArray(), db.categories.toArray(),
    ])
    await db.txns.add({
      date: '2026-03-01', amount: 1_000_00, projectId: projects[0].id,
      sourceId: sources[0].id, categoryId: categories[0].id, voided: 0,
    } as never)

    cleanup()
    renderApp('/')
    await screen.findByRole('heading', { name: 'Summary' })
    expect(await screen.findByText('Properties & budgets')).toBeTruthy()
  })
})

describe('recording a reversal', () => {
  async function fillMinimum(user: ReturnType<typeof userEvent.setup>) {
    // The cost head is sticky between entries, so the picker may already be
    // collapsed onto a previous choice.
    const group = within(screen.getByRole('group', { name: 'For what' }))
    const change = group.queryByRole('button', { name: 'Change' })
    if (change) return
    const box = group.getByPlaceholderText('Permissions, masonry, cement…')
    await user.type(box, 'Build Permit')
    await user.click(await group.findByText(/Add “Build Permit”/))
  }

  it('accepts a negative amount and stores it signed', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.type(screen.getByLabelText('Amount in rupees'), '-141007')
    await fillMinimum(user)

    // The importer always kept negatives and every total nets them; this
    // screen used to be the only place that refused.
    const save = screen.getByRole('button', { name: /Save & add another/ })
    expect(save.hasAttribute('disabled')).toBe(false)
    await user.click(save)

    await waitFor(async () => expect(await db.txns.count()).toBe(1))
    expect((await db.txns.toArray())[0].amount).toBe(-1_41_007_00)
  })

  it('says plainly what a negative will do', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.type(screen.getByLabelText('Amount in rupees'), '-500')

    // A stray minus must not quietly become a reversal.
    expect(await screen.findByText(/Recorded as a reversal/)).toBeTruthy()
  })

  it('offers a sign toggle, since the iOS keypad has no minus', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.type(screen.getByLabelText('Amount in rupees'), '141007')
    await user.click(screen.getByRole('button', { name: 'Make this a reversal or refund' }))

    expect((screen.getByLabelText('Amount in rupees') as HTMLInputElement).value).toBe('-141007')
    // And back again.
    await user.click(screen.getByRole('button', { name: 'Make this a payment out' }))
    expect((screen.getByLabelText('Amount in rupees') as HTMLInputElement).value).toBe('141007')
  })

  it('still refuses zero, which records nothing', async () => {
    const user = userEvent.setup()
    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })

    await user.type(screen.getByLabelText('Amount in rupees'), '0')
    await fillMinimum(user)

    expect(await screen.findByText('Zero records nothing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Save$/ }).hasAttribute('disabled')).toBe(true)
  })

  it('a reversal puts the money back on the source', async () => {
    const user = userEvent.setup()
    const source = (await db.sources.toArray())[0]
    await db.fundIns.add({
      date: '2026-01-01', sourceId: source.id, amount: 5_00_000_00, origin: 'Loan',
    } as never)

    renderApp('/add')
    await screen.findByRole('heading', { name: 'Add payment' })
    await user.type(screen.getByLabelText('Amount in rupees'), '-141007')
    await fillMinimum(user)
    await user.click(screen.getByRole('button', { name: /Save & add another/ }))
    await waitFor(async () => expect(await db.txns.count()).toBe(1))

    const { sourceBalances } = await import('../db/queries')
    const balance = (await sourceBalances()).find((b) => b.source.id === source.id)!
    // Outflow goes *down* by the reversal, so the balance goes up.
    expect(balance.outflow).toBe(-1_41_007_00)
    expect(balance.balance).toBe(5_00_000_00 + 1_41_007_00)
  })
})

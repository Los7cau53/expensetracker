// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Firebase is mocked so the allowlist behaviour can be tested without a real
 * Google sign-in. What matters here is that a wrong account is told what
 * happened, and that nothing is attempted against the database on its behalf.
 */
let currentUser: { uid: string; email: string | null } | null = null
const signOutSpy = vi.fn(async () => {
  currentUser = null
})
const signInSpy = vi.fn(async () => {})
const pullSpy = vi.fn(async () => [])
const pushSpy = vi.fn(async () => {})

vi.mock('../sync/firebase', () => ({
  watchUser: async (cb: (u: unknown) => void) => {
    cb(currentUser)
    return () => {}
  },
  signInWithGoogle: () => signInSpy(),
  signOutOfGoogle: () => signOutSpy(),
  getFirestoreDb: async () => ({}),
}))

vi.mock('../sync/firestore', () => ({
  createFirestoreRemote: async () => ({ pull: pullSpy, push: pushSpy }),
}))

const { SyncPanel } = await import('../components/SyncPanel')

beforeEach(() => {
  currentUser = null
  signOutSpy.mockClear()
  pullSpy.mockClear()
  pushSpy.mockClear()
  localStorage.setItem('ce.syncEnabled', '1')
})
afterEach(cleanup)

describe('an account that is not on the allowlist', () => {
  it('is told why, naming the account and who is allowed', async () => {
    currentUser = { uid: 'stranger', email: 'someone.else@gmail.com' }
    render(<SyncPanel />)

    expect(await screen.findByText('This account cannot sync')).toBeTruthy()
    expect(await screen.findByText(/someone\.else@gmail\.com/)).toBeTruthy()
    expect(await screen.findByText(/ratna\.teja06@gmail\.com/)).toBeTruthy()
    // The rules are the enforcement; the UI must not imply otherwise.
    expect(await screen.findByText(/enforced by\s+the database rules, not just here/)).toBeTruthy()
  })

  it('never touches the database on its behalf', async () => {
    currentUser = { uid: 'stranger', email: 'someone.else@gmail.com' }
    render(<SyncPanel />)
    await screen.findByText('This account cannot sync')
    await new Promise((r) => setTimeout(r, 50))

    // A push would only earn a PERMISSION_DENIED, and the reader would see a
    // failure rather than an explanation.
    expect(pushSpy).not.toHaveBeenCalled()
    expect(pullSpy).not.toHaveBeenCalled()
  })

  it('reassures that the local ledger is untouched', async () => {
    currentUser = { uid: 'stranger', email: 'someone.else@gmail.com' }
    render(<SyncPanel />)
    expect(
      await screen.findByText(/Nothing on this device has changed/),
    ).toBeTruthy()
  })

  it('offers a way out', async () => {
    const user = userEvent.setup()
    currentUser = { uid: 'stranger', email: 'someone.else@gmail.com' }
    render(<SyncPanel />)

    await user.click(await screen.findByRole('button', { name: /Sign out and try another account/ }))
    expect(signOutSpy).toHaveBeenCalled()
  })
})

describe('the owner account', () => {
  it('syncs, and is not shown the rejection', async () => {
    currentUser = { uid: 'owner-uid', email: 'ratna.teja06@gmail.com' }
    render(<SyncPanel />)

    await waitFor(() => expect(pullSpy).toHaveBeenCalled())
    expect(screen.queryByText('This account cannot sync')).toBeNull()
    expect(await screen.findByText(/ratna\.teja06@gmail\.com/)).toBeTruthy()
  })

  it('is matched case-insensitively', async () => {
    currentUser = { uid: 'owner-uid', email: 'Ratna.Teja06@Gmail.com' }
    render(<SyncPanel />)

    await waitFor(() => expect(pullSpy).toHaveBeenCalled())
    expect(screen.queryByText('This account cannot sync')).toBeNull()
  })
})

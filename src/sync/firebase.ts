import type { Auth, User } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

/**
 * Firebase project config.
 *
 * Public by design — it identifies the project, it does not authorise anything.
 * Access is decided by the Firestore security rules in `firestore.rules`,
 * which scope every document to the Google account that owns it.
 */
const firebaseConfig = {
  apiKey: 'AIzaSyB0vnSiu-sCgr6BzgA5JiQvBsNGP19F9PI',
  authDomain: 'construction-tracker-68275.firebaseapp.com',
  projectId: 'construction-tracker-68275',
  storageBucket: 'construction-tracker-68275.firebasestorage.app',
  messagingSenderId: '522329297838',
  appId: '1:522329297838:web:c601b309f51851ad516e3f',
}

/**
 * Everything here is behind a dynamic import.
 *
 * The Firebase SDK is ~160 KB gzipped — larger than the rest of the app put
 * together. Importing it statically made every cold start pay for it,
 * including the sessions that never sign in. Loaded on demand it costs only
 * the people using sync, once, and the service worker caches it after that.
 */
let loaded: Promise<{ auth: Auth; firestore: Firestore }> | null = null

function load() {
  if (!loaded) {
    loaded = (async () => {
      const [{ initializeApp }, { getAuth }, { getFirestore }] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/firestore'),
      ])
      const app = initializeApp(firebaseConfig)
      return { auth: getAuth(app), firestore: getFirestore(app) }
    })()
  }
  return loaded
}

export type { User, Firestore }

export async function getFirestoreDb(): Promise<Firestore> {
  return (await load()).firestore
}

export async function watchUser(
  onChange: (user: User | null) => void,
): Promise<() => void> {
  const { auth } = await load()
  const { onAuthStateChanged } = await import('firebase/auth')
  return onAuthStateChanged(auth, onChange)
}

/**
 * Signs in with Google.
 *
 * Popup first, redirect as a fallback. An installed PWA is the awkward case:
 * iOS opens the popup outside the app's window, and Safari's storage
 * partitioning can break the redirect handler hosted on firebaseapp.com.
 * Trying both gives the best chance across devices.
 */
export async function signInWithGoogle(): Promise<void> {
  const { auth } = await load()
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth')

  const provider = new GoogleAuthProvider()
  // Always ask which account rather than silently reusing one.
  provider.setCustomParameters({ prompt: 'select_account' })

  try {
    await signInWithPopup(auth, provider)
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    // A reader who closed the popup meant to cancel; do not then redirect them.
    if (code === 'auth/popup-closed-by-user') throw e
    if (
      code === 'auth/popup-blocked' ||
      code === 'auth/cancelled-popup-request' ||
      code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(auth, provider)
      return
    }
    throw e
  }
}

export async function signOutOfGoogle(): Promise<void> {
  const { auth } = await load()
  const { signOut } = await import('firebase/auth')
  await signOut(auth)
}

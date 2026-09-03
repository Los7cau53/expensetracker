import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { migrateLegacyIfNeeded } from './db/migrateLegacy'
import { requestPersistentStorage, seedIfEmpty } from './db/seed'
import './index.css'

// Before seeding: the legacy database's rows must land in an empty database,
// not alongside a fresh set of defaults.
const migration = await migrateLegacyIfNeeded()
if (migration.ran && migration.spentBefore !== migration.spentAfter) {
  // Loud on purpose. The old database is still intact, so this is recoverable,
  // but nobody should keep entering payments against a ledger that did not
  // come across whole.
  console.error(
    `Legacy migration total mismatch: ${migration.spentBefore} before, ${migration.spentAfter} after.`,
  )
}

await seedIfEmpty()
void requestPersistentStorage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)

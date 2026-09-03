import { NavLink, Route, Routes } from 'react-router-dom'
import AddEntry from './screens/AddEntry'
import Categories from './screens/Categories'
import Settings from './screens/Settings'
import Ledger from './screens/Ledger'
import PayeeDetail from './screens/PayeeDetail'
import Payees from './screens/Payees'
import Projects from './screens/Projects'
import SourceDetail from './screens/SourceDetail'
import Sources from './screens/Sources'
import Summary from './screens/Summary'

const TABS = [
  { to: '/', label: 'Summary', icon: '◔' },
  { to: '/ledger', label: 'Ledger', icon: '≡' },
  { to: '/add', label: 'Add', icon: '＋', prominent: true },
  { to: '/sources', label: 'Sources', icon: '⛁' },
  { to: '/payees', label: 'Payees', icon: '☺' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Summary />} />
        <Route path="/properties" element={<Projects />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route path="/add" element={<AddEntry />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/sources/:id" element={<SourceDetail />} />
        <Route path="/payees" element={<Payees />} />
        <Route path="/payees/:id" element={<PayeeDetail />} />
        <Route path="/settings" element={<Settings />} />
        {/* The old path: kept so links and bookmarks out in the wild still land. */}
        <Route path="/data" element={<Settings />} />
        <Route path="/categories" element={<Categories />} />
      </Routes>

      <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="mx-auto flex max-w-2xl">
          {TABS.map((t) => (
            <li key={t.to} className="flex-1">
              <NavLink
                to={t.to}
                end={t.to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition ${
                    isActive ? 'text-accent' : 'text-muted'
                  }`
                }
              >
                <span className={t.prominent ? 'text-2xl leading-5' : 'text-lg leading-5'}>
                  {t.icon}
                </span>
                {t.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}

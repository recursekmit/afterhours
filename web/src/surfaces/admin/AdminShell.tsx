/*
  Console shell: index-tab side nav built from the feature registry (plus the
  core panels: participants, desk, kits and projector), and a routed content area.
*/
import { Suspense } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { consolePanels } from '../../core/featureHost';
import { useStaffSignOut } from '../../core/queries';
import { Button, Doodle, EmptyState, type IconName, LoadingState, RecurseLogo, type Tone } from '../../kit';
import { Wordmark } from '../shared/Wordmark';
import s from './admin.module.css';
import { DeskPanel } from './DeskPanel';
import { KitsPanel } from './KitsPanel';
import { ParticipantsPanel } from './ParticipantsPanel';
import { ProjectorPanel } from './ProjectorPanel';

interface NavEntry {
  path: string;
  label: string;
  icon: IconName;
}

const CORE: NavEntry[] = [
  { path: 'participants', label: 'participants', icon: 'users' },
  { path: 'desk', label: 'desk', icon: 'qr' },
  { path: 'kits', label: 'kits', icon: 'ticket' },
  { path: 'projector', label: 'projector', icon: 'screen' },
];
const entry = (p: (typeof consolePanels)[number]): NavEntry => ({ path: p.path, label: p.label, icon: p.icon });
// A panel with a negative `order` (quick session) is listed ahead of the core panels.
const NAV: NavEntry[] = [...consolePanels.filter((p) => p.order < 0).map(entry), ...CORE, ...consolePanels.filter((p) => p.order >= 0).map(entry)];
const TONES: Tone[] = ['tangerine', 'lime', 'pink', 'sky', 'sun', 'grape'];

export function AdminShell() {
  const signOut = useStaffSignOut('admin');
  return (
    <div className={s.shell}>
      <aside className={s.side}>
        <div className={s.brand}>
          <Wordmark size={34} />
          <RecurseLogo height={26} />
          <p className={s.brandNote}>organiser console</p>
        </div>
        <nav className={s.nav} aria-label="console">
          {NAV.map((n, i) => (
            <NavLink key={n.path} to={`/admin/${n.path}`} className={({ isActive }) => `${s.navItem} ${isActive ? s.navOn : ''}`} style={{ ['--tab' as string]: `var(--${TONES[i % TONES.length]})` }}>
              <Doodle name={n.icon} size={24} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <Button tone="paper" size="sm" ghost onClick={() => signOut.mutate()}>
          lock console
        </Button>
      </aside>
      <main className={s.content}>
        <Routes>
          <Route index element={<Navigate to="kits" replace />} />
          <Route path="participants" element={<ParticipantsPanel />} />
          <Route path="desk" element={<DeskPanel />} />
          <Route path="kits" element={<KitsPanel />} />
          <Route path="projector" element={<ProjectorPanel />} />
          {consolePanels.map((p) => (
            <Route
              key={p.path}
              path={`${p.path}/*`}
              element={
                <div className={s.panel}>
                  <h1 className={s.panelTitle}>{p.label}</h1>
                  <Suspense fallback={<LoadingState label="loading panel..." />}>
                    <p.Panel />
                  </Suspense>
                </div>
              }
            />
          ))}
          <Route path="*" element={<EmptyState title="no such panel" hint="pick one from the left." mood="oops" />} />
        </Routes>
      </main>
    </div>
  );
}

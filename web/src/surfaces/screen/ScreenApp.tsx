/* Projector surface (/screen). PIN gate, then the scene host. Dark "after hours" variant. */
import { useEffect } from 'react';
import { LiveProvider } from '../../core/live';
import { useStaffSession, useStaffSignOut } from '../../core/queries';
import { Button, DoodleDefs, ToastProvider } from '../../kit';
import { PinGate } from '../shared/PinGate';
import { SceneHost } from './SceneHost';
import s from './screen.module.css';

/** A small, quiet "log out" in the corner, for when the projector laptop is handed back. Ends the session server side. */
function ScreenLogout() {
  const out = useStaffSignOut('screen');
  return (
    <div className={s.logout}>
      <Button size="sm" tone="paper" ghost icon="lock" loading={out.isPending} onClick={() => out.mutate()} data-testid="screen-logout">
        log out
      </Button>
    </div>
  );
}

export default function ScreenApp() {
  const session = useStaffSession('screen');
  useEffect(() => {
    document.body.dataset.surface = 'dusk';
    return () => document.body.removeAttribute('data-surface');
  }, []);
  return (
    <LiveProvider identity={session.data ? 'screen' : 'anon'}>
      <ToastProvider>
        <DoodleDefs />
        <PinGate role="screen">
          <SceneHost />
          <ScreenLogout />
        </PinGate>
      </ToastProvider>
    </LiveProvider>
  );
}

/*
  Attendee surface (/). Gate order: sign in -> first-time profile -> the app.
  The live connection lives above the gate so the sticker you earn by signing
  in reaches you the moment the session exists.
*/
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { LiveProvider, useLiveEvent } from '../../core/live';
import { qk, useMe } from '../../core/queries';
import { StickerCelebration } from '../../fun';
import { DoodleDefs, ErrorState, ToastProvider, useToast } from '../../kit';
import { DesktopAside, Splash } from './Frame';
import { Profile } from './Profile';
import { Shell } from './Shell';
import { SignIn } from './SignIn';

function LiveReactors() {
  const qc = useQueryClient();
  const toast = useToast();
  useLiveEvent('points.awarded', (d) => {
    void qc.invalidateQueries({ queryKey: qk.points });
    toast(d.label ?? d.source, { kind: 'points', title: `+${d.points} points`, ms: 2400 });
  });
  useLiveEvent('presence.changed', (d) => qc.setQueryData(qk.presence, d));
  useLiveEvent('session.revoked', () => {
    qc.setQueryData(qk.me, null);
    toast('The desk reset your kit. Sign in again to get back in.', { kind: 'info', title: 'signed out' });
  });
  return null;
}

/**
  Each feature area is printed on its home ticket (docs/SPEC.md section 2): morse + slips on the armillary
  maroon, hunt + trails on the wave navy, polls + schedule + check-in on the ginkgo forest, arcade + drops +
  recap on the ruins plum. Home, the wallet and the rest stay on the base wave palette.
*/
export function paletteFor(path: string): string {
  if (/^\/(morse|dev\/slips)/.test(path)) return 'armillary';
  if (/^\/(hunt|trails)/.test(path)) return 'wave';
  if (/^\/(polls|schedule|checkin|attendance)/.test(path)) return 'ginkgo';
  if (/^\/(arcade|drop|recap|stickers)/.test(path)) return 'ruins';
  return 'wave';
}

export function AttendeeApp() {
  const me = useMe();
  const { pathname } = useLocation();
  useEffect(() => {
    document.body.dataset.surface = 'phone';
    return () => document.body.removeAttribute('data-surface');
  }, []);
  useEffect(() => {
    document.body.dataset.palette = paletteFor(pathname);
  }, [pathname]);
  useEffect(() => () => document.body.removeAttribute('data-palette'), []);
  const identity = me.data ? `a${me.data.attendee.id}` : 'anon';

  return (
    <LiveProvider identity={identity}>
      <ToastProvider>
        <DoodleDefs />
        <DesktopAside />
        {me.isPending ? (
          <Splash />
        ) : me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : !me.data ? (
          <SignIn />
        ) : (
          <>
            <LiveReactors />
            <StickerCelebration />
            {me.data.attendee.profileComplete ? <Shell me={me.data} /> : <Profile me={me.data} />}
          </>
        )}
      </ToastProvider>
    </LiveProvider>
  );
}

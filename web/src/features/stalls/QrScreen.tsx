/*
  /wallet/qr: the full-screen QR you hold up at a stall. Bright, high contrast, with your avatar,
  nickname and a short typed code under it. It rotates every 30 s (a screenshot sent to a friend stops
  working), keeps the screen awake where the Wake Lock API exists, and closes itself when the
  shopkeeper hands you something.
*/
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { serverNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { useMe } from '../../core/queries';
import { Avatar, Button, Doodle, ErrorState, LoadingState, Qr } from '../../kit';
import { useCart, useQr, useWallet } from './api';
import { Glasses } from './Wallet';
import s from './stalls.module.css';

function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let dead = false;
    const grab = async () => {
      try {
        if (dead || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
        lock = await navigator.wakeLock.request('screen');
      } catch {
        // no wake lock here (battery saver, old browser): the screen may dim, the QR still works
      }
    };
    void grab();
    const onVis = () => void grab();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

function useQrSize(): number {
  const calc = () => Math.max(180, Math.min(window.innerWidth - 64, window.innerHeight * 0.42, 440));
  const [size, setSize] = useState(calc);
  useEffect(() => {
    const on = () => setSize(calc());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

export function QrScreen() {
  const nav = useNavigate();
  const me = useMe().data?.attendee;
  const qr = useQr();
  const wallet = useWallet();
  const cart = useCart();
  const reduce = useReducedMotion();
  const size = useQrSize();
  const [leftMs, setLeftMs] = useState<number | null>(null);
  useWakeLock();

  // A hand-over closes this screen: the celebration overlay takes it from here.
  useLiveEvent('stalls.redeemed', () => nav('/wallet', { replace: true }));

  // Rotate on the server's window edge, using the app-wide server clock offset (never the phone clock).
  const data = qr.data;
  useEffect(() => {
    if (!data) return;
    const tick = () => setLeftMs(Math.max(0, data.expiresAt - serverNow()));
    tick();
    const iv = window.setInterval(tick, 250);
    const to = window.setTimeout(() => void qr.refetch(), Math.max(400, data.expiresAt - serverNow() + 150));
    return () => {
      window.clearInterval(iv);
      window.clearTimeout(to);
    };
  }, [data, qr]);
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && void qr.refetch();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [qr]);

  const basket = (cart.data?.lines ?? []).reduce((a, l) => a + l.qty, 0);
  const code = data ? `${data.code.slice(0, 3)} ${data.code.slice(3)}` : '';

  return (
    <div className={s.qrScreen} role="dialog" aria-label="your QR code for the stalls">
      <div className={s.qrTop}>
        <Button tone="paper" size="sm" icon="close" onClick={() => nav('/wallet', { replace: true })} aria-label="close">
          close
        </Button>
        <div className={s.qrWho}>
          {me?.avatar && <Avatar config={me.avatar} size={52} />}
          <b className={s.qrNick}>{me?.nickname ?? 'you'}</b>
        </div>
      </div>

      {qr.isPending ? (
        <LoadingState label="making your code..." />
      ) : qr.isError && !data ? (
        <ErrorState error={qr.error} onRetry={() => void qr.refetch()} title="no code yet" />
      ) : data ? (
        <motion.div key={data.token} initial={reduce ? false : { scale: 0.92, rotate: -2 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} className={s.qrCard}>
          <Qr text={data.url} size={size} label="your QR code" />
          <p className={s.qrCode} aria-label={`typed code ${data.code.split('').join(' ')}`}>
            {code}
          </p>
          <div className={s.qrBar} aria-hidden="true">
            <i style={{ width: `${Math.round(((leftMs ?? 0) / data.windowMs) * 100)}%` }} />
          </div>
          <p className={s.fine}>new code in {Math.ceil((leftMs ?? 0) / 1000)}s. no screenshots, it changes.</p>
        </motion.div>
      ) : null}

      <div className={s.qrFoot}>
        {wallet.data && <Glasses total={wallet.data.allowance.total} left={wallet.data.allowance.left} size={34} />}
        <p className={s.qrFootText}>
          {wallet.data ? `${wallet.data.allowance.left} free left, ${wallet.data.balance} pts` : ''}
          {basket > 0 ? `, basket of ${basket}` : ''}
        </p>
      </div>
      <p className={s.qrHint}>
        <Doodle name="bolt" size={18} fill="var(--sun)" /> crank your brightness up. hold it steady for the camera.
      </p>
    </div>
  );
}

/*
  The shopkeeper's surface (/stall). Phone and tablet first, one-handed, readable in sunlight.
    sign in with the stall code (stays signed in for the day)
    -> scan (camera where the browser has BarcodeDetector, otherwise type the short code;
       /stall/r/<token> opened from the phone camera lands here too)
    -> the redemption sheet (free mocktails left, balance, basket, this stall's menu as big tiles)
    -> "hand it over" commits atomically -> a big success screen -> straight back to scanning.
*/
import type { CommitResponse, ScanResponse, ShopMe } from '@afterhours/shared/features/stalls';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isApiError } from '../../core/api';
import { Button, DoodleDefs, ErrorState, LoadingState, ToastProvider } from '../../kit';
import { StallMark } from '../../features/stalls/parts';
import { Counter } from './Counter';
import { Done } from './Done';
import { Handover } from './Handover';
import { SignIn } from './SignIn';
import { fetchShopMe, shopMeKey, shopScan, shopSignOut } from './api';
import s from './stall.module.css';

type View = { kind: 'scan' } | { kind: 'sheet'; scan: ScanResponse } | { kind: 'done'; result: CommitResponse };

function Signed({ me, onSignOut }: { me: ShopMe; onSignOut: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { token } = useParams();
  const [view, setView] = useState<View>({ kind: 'scan' });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tally, setTally] = useState(me.tally);
  const scanning = useRef(false);

  const scan = useCallback(
    async (input: string) => {
      if (scanning.current) return;
      scanning.current = true;
      setBusy(true);
      setNote(null);
      try {
        const r = await shopScan(input);
        setView({ kind: 'sheet', scan: r });
      } catch (e) {
        if (isApiError(e, 'unauthorized')) {
          qc.setQueryData(shopMeKey, null);
        } else setNote(e instanceof Error ? e.message : 'That did not scan. Try again.');
      } finally {
        scanning.current = false;
        setBusy(false);
      }
    },
    [qc],
  );

  // /stall/r/<token> opened straight from the phone camera: scan it once, then clean the URL.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!token || handled.current === token) return;
    handled.current = token;
    nav('/stall', { replace: true });
    void scan(token);
  }, [token, nav, scan]);

  const finish = (r: CommitResponse) => {
    setTally(r.tally);
    setView({ kind: 'done', result: r });
  };

  return (
    <div className={s.app}>
      <header className={s.bar}>
        <span className={s.barStall}>
          <StallMark value={me.stall.emoji} size={30} />
          <b>{me.stall.name}</b>
        </span>
        <span className={s.barTally} aria-label="handed out today">
          <b>{tally.units}</b> handed out
        </span>
        <Button size="sm" tone="paper" onClick={onSignOut}>
          sign out
        </Button>
      </header>
      {view.kind === 'scan' && <Counter tally={tally} note={note} busy={busy} onInput={(v) => void scan(v)} />}
      {view.kind === 'sheet' && <Handover key={view.scan.ticket} scan={view.scan} onCancel={() => setView({ kind: 'scan' })} onDone={finish} onExpired={(m) => (setNote(m), setView({ kind: 'scan' }))} />}
      {view.kind === 'done' && <Done result={view.result} onNext={() => setView({ kind: 'scan' })} />}
    </div>
  );
}

export default function StallApp() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: shopMeKey, queryFn: fetchShopMe, retry: false });
  useEffect(() => {
    document.body.dataset.surface = 'stall';
    return () => document.body.removeAttribute('data-surface');
  }, []);
  const signOut = () => {
    void shopSignOut().finally(() => qc.setQueryData(shopMeKey, null));
  };
  return (
    <ToastProvider>
      <DoodleDefs />
      {me.isPending ? (
        <LoadingState label="checking your stall..." />
      ) : me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : me.data ? (
        <Signed me={me.data} onSignOut={signOut} />
      ) : (
        <SignIn onDone={(m) => qc.setQueryData(shopMeKey, m)} />
      )}
    </ToastProvider>
  );
}

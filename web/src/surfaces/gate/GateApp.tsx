/*
  Door coordinator surface (/gate). Phone-first, protected by its own GATE_PIN.
  Scan a student's college ID card (or type a roll/name) to verify they are on
  the registered list, mark them let in at the door, and catch duplicate entries.
*/
import {
  type GateCount,
  GateEnterResponseSchema,
  GateLookupResponseSchema,
  type GatePerson,
  type GateStats,
  GateStatsSchema,
  GateUndoResponseSchema,
} from '@afterhours/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../core/api';
import { LiveProvider, useLiveEvent } from '../../core/live';
import { qk, useStaffSession, useStaffSignOut } from '../../core/queries';
import { IdScanner } from '../../features/common/IdScanner';
import { haptics, sfx } from '../../fun';
import { Button, Card, Doodle, DoodleDefs, ErrorState, LoadingState, Mascot, NumberTicker, TextField, ToastProvider, useToast } from '../../kit';
import { PinGate } from '../shared/PinGate';
import s from './gate.module.css';

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let dead = false;
    const grab = async () => {
      try {
        if (!dead && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
          lock = await navigator.wakeLock.request('screen');
        }
      } catch {
        /* screen may dim; scanning still works */
      }
    };
    void grab();
    const vis = () => void grab();
    document.addEventListener('visibilitychange', vis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', vis);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

type View =
  | { k: 'scan' }
  | { k: 'checking' }
  | { k: 'person'; person: GatePerson; justEntered: boolean; fromPick?: { query: string; read: 'qr' | 'roll' | 'search'; qrSuffix: string | null; matches: GatePerson[] } }
  | { k: 'pick'; query: string; read: 'qr' | 'roll' | 'search'; qrSuffix: string | null; matches: GatePerson[] }
  | { k: 'not_found'; query: string; read: 'qr' | 'roll' | 'search'; qrSuffix: string | null };

function GateWorkspace() {
  useWakeLock();
  const qc = useQueryClient();
  const toast = useToast();
  const signOut = useStaffSignOut('gate');

  const [view, setView] = useState<View>({ k: 'scan' });
  const [cameraOn, setCameraOn] = useState(true);
  const [typed, setTyped] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);

  const stats = useQuery({
    queryKey: qk.gateStats,
    queryFn: () => api.get('/api/gate/stats', GateStatsSchema),
    refetchInterval: 15_000,
  });

  useLiveEvent('gate.changed', () => {
    void qc.invalidateQueries({ queryKey: qk.gateStats });
  });

  const syncCount = useCallback(
    (c: GateCount) => {
      qc.setQueryData(qk.gateStats, (old: GateStats | undefined) => (old ? { ...old, total: c.total, entered: c.entered } : old));
    },
    [qc],
  );

  const runLookup = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      setLookupError(null);
      setView({ k: 'checking' });
      try {
        const r = await api.post('/api/gate/lookup', { q }, GateLookupResponseSchema);
        syncCount(r.stats);
        if (r.matches.length === 0) {
          sfx.fail();
          haptics.fail();
          setView({ k: 'not_found', query: q, read: r.read, qrSuffix: r.qrSuffix });
        } else if (r.matches.length === 1) {
          const person = r.matches[0]!;
          if (person.gateEnteredAt !== null) {
            sfx.fail();
            haptics.fail();
          } else {
            sfx.pop();
            haptics.tap();
          }
          setView({ k: 'person', person, justEntered: false });
        } else {
          sfx.pop();
          haptics.tap();
          setView({ k: 'pick', query: q, read: r.read, qrSuffix: r.qrSuffix, matches: r.matches });
        }
      } catch (err) {
        sfx.fail();
        haptics.fail();
        setLookupError(err instanceof Error ? err.message : 'Lookup failed. Try again.');
        setView({ k: 'scan' });
      }
    },
    [syncCount],
  );

  const enter = useMutation({
    mutationFn: (id: number) => api.post(`/api/gate/participants/${id}/enter`, {}, GateEnterResponseSchema),
    onSuccess: (r) => {
      syncCount(r.stats);
      void qc.invalidateQueries({ queryKey: qk.gateStats });
      if (r.newlyEntered) {
        sfx.success();
        haptics.success();
        setView((prev) => (prev.k === 'person' ? { ...prev, person: r.person, justEntered: true } : { k: 'person', person: r.person, justEntered: true }));
      } else {
        sfx.fail();
        haptics.fail();
        toast('Already marked entered on another device.', { kind: 'info', title: 'already in' });
        setView((prev) => (prev.k === 'person' ? { ...prev, person: r.person, justEntered: false } : { k: 'person', person: r.person, justEntered: false }));
      }
    },
    onError: (err) => {
      sfx.fail();
      haptics.fail();
      toast(err.message, { kind: 'bad', title: 'could not mark entered' });
    },
  });

  const undo = useMutation({
    mutationFn: (id: number) => api.post(`/api/gate/participants/${id}/undo`, {}, GateUndoResponseSchema),
    onSuccess: (r) => {
      syncCount(r.stats);
      void qc.invalidateQueries({ queryKey: qk.gateStats });
      sfx.tick();
      haptics.tick();
      toast(`Cleared entry for ${r.person.name}.`, { kind: 'info', title: 'entry undone' });
      setView((prev) => (prev.k === 'person' ? { ...prev, person: r.person, justEntered: false } : { k: 'person', person: r.person, justEntered: false }));
    },
    onError: (err) => {
      sfx.fail();
      haptics.fail();
      toast(err.message, { kind: 'bad', title: 'could not undo' });
    },
  });

  const resetToScan = () => {
    setTyped('');
    setLookupError(null);
    setView({ k: 'scan' });
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    void runLookup(typed);
  };

  return (
    <div className={s.app}>
      <header className={s.bar}>
        <span className={s.barBrand}>
          <Doodle name="qr" size={24} />
          <span>door gate</span>
        </span>
        <span className={s.barCount} data-testid="gate-count" aria-label="entered count">
          <b>
            <NumberTicker value={stats.data?.entered ?? 0} />
          </b>
          <span>/ {stats.data?.total ?? 0} in</span>
        </span>
        <Button size="sm" tone="paper" ghost onClick={() => signOut.mutate()}>
          lock
        </Button>
      </header>

      <main className={s.main}>
        {view.k === 'scan' && (
          <>
            {lookupError && (
              <p className={s.errorNote} role="alert">
                {lookupError}
              </p>
            )}

            <Card tone="paper" tape tapeColor="sun" className={s.stack}>
              <div className={s.headRow}>
                <div>
                  <h1 className={s.cardTitle}>scan student ID</h1>
                  <p className={s.sub}>hold their college ID QR inside the frame.</p>
                </div>
                <Button size="sm" tone="paper" onClick={() => setCameraOn((v) => !v)}>
                  {cameraOn ? 'hide cam' : 'open cam'}
                </Button>
              </div>
              {cameraOn && (
                <IdScanner
                  facing="environment"
                  hint="point at the college ID QR"
                  onCode={(text) => void runLookup(text)}
                  fallbackLabel="hide camera"
                  onFallback={() => setCameraOn(false)}
                />
              )}
            </Card>

            <Card tone="paper" className={s.stack}>
              <h2 className={s.cardTitle}>or look up by roll / name</h2>
              <form className={s.searchRow} onSubmit={submitManual} noValidate>
                <TextField
                  label="roll number, last 4, or name"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="26BD1A0501 or Divya"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  data-testid="gate-query"
                />
                <Button type="submit" tone="lime" icon="search" disabled={!typed.trim()} data-testid="gate-check-btn">
                  check
                </Button>
              </form>
            </Card>

            {stats.isError && <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />}

            {stats.data && stats.data.recent.length > 0 && (
              <Card tone="paper" className={s.stack}>
                <div className={s.headRow}>
                  <h2 className={s.cardTitle}>recently let in</h2>
                  <span className={s.sub}>{stats.data.entered} total</span>
                </div>
                <ul className={s.recentList} data-testid="gate-recent">
                  {stats.data.recent.slice(0, 8).map((r) => (
                    <li key={r.id} className={s.recentItem}>
                      <div className={s.recentWho}>
                        <span className={s.recentName}>{r.name}</span>
                        <span className={s.recentMeta}>{[r.roll, r.year, r.section].filter(Boolean).join(' · ')}</span>
                      </div>
                      <span className={s.recentTime}>{fmtTime(r.gateEnteredAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        {view.k === 'checking' && (
          <Card tone="paper">
            <LoadingState label="checking the list..." />
          </Card>
        )}

        {view.k === 'person' && (
          <PersonVerdict
            person={view.person}
            justEntered={view.justEntered}
            entering={enter.isPending}
            undoing={undo.isPending}
            onEnter={() => enter.mutate(view.person.id)}
            onUndo={() => undo.mutate(view.person.id)}
            onNext={resetToScan}
            onBackToPick={
              view.fromPick
                ? () =>
                    setView({
                      k: 'pick',
                      query: view.fromPick!.query,
                      read: view.fromPick!.read,
                      qrSuffix: view.fromPick!.qrSuffix,
                      matches: view.fromPick!.matches.map((m) => (m.id === view.person.id ? view.person : m)),
                    })
                : undefined
            }
          />
        )}

        {view.k === 'pick' && (
          <Card tone="paper" tape tapeColor="sun" className={s.stack} data-testid="gate-pick">
            <div>
              <h1 className={s.cardTitle}>{view.matches.length} registered matches</h1>
              <p className={s.sub}>
                {view.read === 'qr' && view.qrSuffix
                  ? `more than one person shares card ending ${view.qrSuffix}. tap the right person to check or let them in.`
                  : `matching "${view.query}". tap a person to open their card.`}
              </p>
            </div>
            <ul className={s.picks}>
              {view.matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={s.pickBtn}
                    data-testid={`gate-pick-${m.roll}`}
                    onClick={() => {
                      if (m.gateEnteredAt !== null) {
                        sfx.fail();
                        haptics.fail();
                      } else {
                        sfx.pop();
                        haptics.tap();
                      }
                      setView({
                        k: 'person',
                        person: m,
                        justEntered: false,
                        fromPick: { query: view.query, read: view.read, qrSuffix: view.qrSuffix, matches: view.matches },
                      });
                    }}
                  >
                    <div className={s.pickTop}>
                      <span className={s.pickName}>{m.name}</span>
                      <span className={s.pickRoll}>{m.roll}</span>
                    </div>
                    <div className={s.pickBottom}>
                      <span>{[m.year, m.section, m.phoneLast4 ? `phone ...${m.phoneLast4}` : null].filter(Boolean).join(' · ') || 'registered'}</span>
                      <span className={`${s.badge} ${m.gateEnteredAt !== null ? s.badgeWarn : s.badgeGood}`}>
                        {m.gateEnteredAt !== null ? `already in · ${fmtTime(m.gateEnteredAt)}` : 'valid · not in yet'}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <Button tone="paper" icon="qr" block onClick={resetToScan}>
              scan next person
            </Button>
          </Card>
        )}

        {view.k === 'not_found' && (
          <Card tone="pink" tape tapeColor="pink" lift halftone className={s.verdictCard} data-testid="gate-not-found" role="alert">
            <div className={s.verdictHead}>
              <Mascot size={74} mood="oops" />
              <div className={s.verdictText}>
                <span className={`${s.stamp} ${s.stampBad}`}>
                  <Doodle name="close" size={16} /> not registered
                </span>
                <h1 className={s.personName}>not on the list</h1>
              </div>
            </div>
            <p className={s.sub}>
              {view.read === 'qr' && view.qrSuffix
                ? `No registered student matches card ending ${view.qrSuffix}. Check their full roll number or send them to the entry desk.`
                : `No registered student matches "${view.query}". Double-check the roll or send them to the entry desk.`}
            </p>
            <Button tone="paper" size="lg" block icon="qr" onClick={resetToScan} data-testid="gate-scan-next">
              scan next person
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}

function PersonVerdict({
  person,
  justEntered,
  entering,
  undoing,
  onEnter,
  onUndo,
  onNext,
  onBackToPick,
}: {
  person: GatePerson;
  justEntered: boolean;
  entering: boolean;
  undoing: boolean;
  onEnter: () => void;
  onUndo: () => void;
  onNext: () => void;
  onBackToPick?: () => void;
}) {
  const already = person.gateEnteredAt !== null && !justEntered;
  const tone = already ? 'sun' : 'lime';
  const testId = justEntered ? 'gate-entered-now' : already ? 'gate-already' : 'gate-valid';

  return (
    <Card tone={tone} tape tapeColor={already ? 'pink' : 'sun'} lift halftone className={s.verdictCard} data-testid={testId}>
      <div className={s.verdictHead}>
        {justEntered ? (
          <span className={s.doneTick} aria-hidden="true">
            <Doodle name="check" size={42} stroke="currentColor" />
          </span>
        ) : (
          <Mascot size={76} mood={already ? 'oops' : 'wow'} />
        )}
        <div className={s.verdictText}>
          <span className={`${s.stamp} ${already ? s.stampWarn : s.stampGood}`}>
            <Doodle name={already ? 'clock' : 'check'} size={16} />
            {justEntered ? 'let in!' : already ? 'already entered' : 'valid · registered'}
          </span>
          <h1 className={s.personName}>{person.name}</h1>
          <p className={s.personRoll}>{person.roll}</p>
        </div>
      </div>

      {already && person.gateEnteredAt !== null && (
        <div className={s.alreadyBanner} role="alert">
          <Doodle name="clock" size={22} />
          <span>already let in at {fmtTime(person.gateEnteredAt)}</span>
        </div>
      )}

      {justEntered && person.gateEnteredAt !== null && (
        <div className={s.alreadyBanner} role="status">
          <Doodle name="check" size={22} />
          <span>checked in at {fmtTime(person.gateEnteredAt)}</span>
        </div>
      )}

      <dl className={s.facts}>
        <dt>class</dt>
        <dd>{[person.year, person.section].filter(Boolean).join(', ') || 'not given'}</dd>
        <dt>phone</dt>
        <dd>{person.phoneLast4 ? `ends ${person.phoneLast4}` : 'none on file'}</dd>
        <dt>app</dt>
        <dd>{person.signedIn ? 'signed in on phone' : 'not signed in yet'}</dd>
      </dl>

      {person.note && (
        <p className={s.noteBox}>
          <b>desk note:</b> {person.note}
        </p>
      )}

      <div className={s.actions}>
        {!already && !justEntered ? (
          <Button tone="sun" size="lg" block icon="check" loading={entering} onClick={onEnter} data-testid="gate-let-in">
            let them in
          </Button>
        ) : (
          <Button tone={justEntered ? 'sun' : 'ink'} size="lg" block icon="qr" onClick={onNext} data-testid="gate-scan-next">
            scan next person
          </Button>
        )}

        <div className={s.rowActions}>
          {!already && !justEntered && (
            <Button tone="paper" size="sm" icon="qr" onClick={onNext}>
              scan next
            </Button>
          )}
          {onBackToPick && (
            <Button tone="paper" size="sm" ghost onClick={onBackToPick}>
              back to matches
            </Button>
          )}
          {(already || justEntered) && (
            <Button tone="paper" size="sm" ghost icon="undo" loading={undoing} onClick={onUndo} data-testid="gate-undo">
              undo entry
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function GateApp() {
  const session = useStaffSession('gate');
  useEffect(() => {
    document.body.dataset.surface = 'gate';
    return () => document.body.removeAttribute('data-surface');
  }, []);
  return (
    <LiveProvider identity={session.data ? 'gate' : 'anon'}>
      <ToastProvider>
        <DoodleDefs />
        <PinGate role="gate">
          <GateWorkspace />
        </PinGate>
      </ToastProvider>
    </LiveProvider>
  );
}

/*
  Console panel "cipher": show to players, per-player progress, trial counts, guild standings, every
  difficulty value, the private answer key, the Oracle's ticket, pacts, the last signal, and reset.
*/
import { OkSchema } from '@afterhours/shared';
import {
  CIPHER_RESET_PHRASE,
  type CipherAdmin,
  CipherAdminSchema,
  CipherPrintSchema,
  type CipherSettings,
  GUILD_INFO,
  TRIALS,
  TRIAL_INFO,
} from '@afterhours/shared/features/cipher';
import { SLIP_SIZES } from '@afterhours/shared/morse-slip';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { SlipSheet } from '../../lib/slips';
import { Button, Countdown, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, downloadHref, ui } from '../common/ui';
import { mmss, pad3, useCipherAdmin } from './api';
import s from './cipher.module.css';

type NumKey = { [K in keyof CipherSettings]: CipherSettings[K] extends number ? K : never }[keyof CipherSettings];
const NUMS: { group: string; items: [NumKey, string][] }[] = [
  { group: 'the four winds', items: [['windsHint1Sec', 'hint 1 after (s)'], ['windsHint2Sec', 'hint 2 after (s)']] },
  { group: 'the echo', items: [['echoTolerance', 'tolerance (1 strict, 1.5 kind)'], ['echoTries', 'tries'], ['echoStar2', 'rhythm for 2 stars (0-1)'], ['echoStar3', 'rhythm for 3 stars (0-1)']] },
  { group: 'the whisper', items: [['whisperWpm', 'letter speed (wpm)'], ['whisperFarnsworthWpm', 'gap speed (wpm)'], ['whisperMinLetters', 'min letters'], ['whisperMaxLetters', 'max letters'], ['whisperHintCost', 'hint cost (points)']] },
  { group: 'the riddle', items: [['riddleHintCost', 'hint cost (points)']] },
  { group: 'the pact', items: [['pactWaitSec', 'wait before re-pair / oracle (s)']] },
  { group: 'the last signal', items: [['signalWpm', 'speed (wpm)'], ['signalLoops', 'loops'], ['signalFirstN', 'first N win big'], ['signalWindowSec', 'answers open for (s)'], ['signalWarnSec', 'default warning (s)']] },
  { group: 'speed', items: [['parSec', 'par time per trial (s)']] },
];
const POINTS: [keyof CipherSettings['points'], string][] = [
  ['oath', 'oath'],
  ['rune', 'each rune'],
  ['echoStar', 'echo, per star'],
  ['whisper', 'whisper'],
  ['riddle', 'riddle'],
  ['pact', 'pact'],
  ['signalFirst', 'signal, first N'],
  ['signalCorrect', 'signal, correct'],
  ['champion', 'winning guild'],
  ['speed', 'speed bonus'],
];

export default function CipherConsole() {
  const toast = useToast();
  const q = useCipherAdmin();
  const o = q.data;
  const [confirm, setConfirm] = useState('');
  const [oracle, setOracle] = useState(false);
  const done = { onSuccess: () => void q.refetch(), onError: (e: Error) => toast(e.message, { kind: 'bad' }) };
  const visible = useMutation({ mutationFn: (enabled: boolean) => api.put('/api/cipher/admin/visible', { enabled }, CipherAdminSchema), ...done });
  const reset = useMutation({ mutationFn: () => api.post('/api/cipher/admin/reset', { confirm: CIPHER_RESET_PHRASE }, OkSchema), ...done });
  if (!o) return <Section title="the cipher">loading...</Section>;
  return (
    <div className={ui.stack} data-testid="cipher-console">
      <Section
        title="the cipher"
        tape
        action={<Stamp tone={o.visible ? 'live' : 'done'}>{o.visible ? 'players see it' : 'hidden'}</Stamp>}
      >
        <div className={ui.statGrid}>
          <Stat label="sworn in" value={o.players.length} />
          <Stat label="sets claimed" value={o.set ? `${o.set.claimed}/${o.set.copies}` : 'no set'} />
          <Stat label="all seven sealed" value={o.sealed[TRIALS.length - 1] ?? 0} />
        </div>
        {!o.set && <p className={ui.hand}>no Morse slip set yet: the trails console makes "the morse slip" (kind morse, four slips, unique copies).</p>}
        <div className={ui.row}>
          <Button tone={o.visible ? 'pink' : 'lime'} icon={o.visible ? 'lock' : 'play'} onClick={() => visible.mutate(!o.visible)} data-testid="cipher-visible">
            {o.visible ? 'hide from players' : 'show to players'}
          </Button>
          <Button tone="sky" icon="download" onClick={() => downloadHref('/api/cipher/admin/answer-key.csv')}>
            private answer key (csv)
          </Button>
          <Button tone="sun" icon="print" onClick={() => setOracle(true)}>
            print the oracle ticket
          </Button>
        </div>
        <TrialTable o={o} />
      </Section>
      <Section title="guild standings" tilt={0.3}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>rank</th>
              <th>guild</th>
              <th>members</th>
              <th>points</th>
              <th>per member</th>
            </tr>
          </thead>
          <tbody>
            {[...o.guilds]
              .sort((a, b) => a.rank - b.rank)
              .map((g) => (
                <tr key={g.guild} data-guild={g.guild}>
                  <td className={ui.num}>{g.rank}</td>
                  <td>
                    <span className={s.guildCell}>
                      <span className={s.dot} />
                      {GUILD_INFO[g.guild].short} ({GUILD_INFO[g.guild].colour})
                    </span>
                  </td>
                  <td className={ui.num}>{g.members}</td>
                  <td className={ui.num}>{g.points}</td>
                  <td className={ui.num}>{g.average.toFixed(1)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
      <LastSignal o={o} onDone={() => void q.refetch()} />
      <Players o={o} />
      <Pacts o={o} onDone={() => void q.refetch()} />
      <Settings o={o} onSaved={() => void q.refetch()} />
      <Section title="danger zone" tilt={-0.2}>
        <p className={ui.hand}>wipes every cipher trial, pact and signal, and takes back cipher points and stickers. the slips stay claimed.</p>
        <div className={ui.row}>
          <TextField label={`type ${CIPHER_RESET_PHRASE}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button tone="pink" disabled={confirm !== CIPHER_RESET_PHRASE} onClick={() => reset.mutate(undefined, { onSuccess: () => setConfirm('') })}>
            reset the cipher
          </Button>
        </div>
      </Section>
      {oracle && <OracleSheet onClose={() => setOracle(false)} />}
    </div>
  );
}

function TrialTable({ o }: { o: CipherAdmin }) {
  return (
    <table className={ui.table} data-testid="cipher-trials">
      <thead>
        <tr>
          <th>trial</th>
          <th>on it now</th>
          <th>sealed</th>
        </tr>
      </thead>
      <tbody>
        {TRIALS.map((t, i) => (
          <tr key={t}>
            <td>
              {i + 1}. {TRIAL_INFO[t].title}
            </td>
            <td className={ui.num}>{o.onTrial[i] ?? 0}</td>
            <td className={ui.num}>{o.sealed[i] ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LastSignal({ o, onDone }: { o: CipherAdmin; onDone: () => void }) {
  const toast = useToast();
  const [mins, setMins] = useState(Math.round(o.settings.signalWarnSec / 60));
  const [word, setWord] = useState('');
  const sig = o.signal;
  const act = useMutation({
    mutationFn: (b: { action: 'warn' | 'fire' | 'close' | 'reveal' | 'cancel'; inSec?: number; word?: string }) => api.post('/api/cipher/admin/signal', b, CipherAdminSchema),
    onSuccess: () => {
      setWord('');
      onDone();
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const open = sig.status === 'warned' || sig.status === 'live';
  const ready = o.sealed[5] ?? 0;
  return (
    <Section
      title="the last signal"
      tilt={-0.3}
      action={<Stamp tone={sig.status === 'live' ? 'live' : sig.status === 'warned' ? 'info' : 'done'}>{sig.status === 'idle' ? 'not sent' : sig.status}</Stamp>}
    >
      <p className={ui.hand}>
        {ready} {ready === 1 ? 'player has' : 'players have'} sealed the pact and can answer. the projector takes over while it is announced and live, flashes and beeps the word {o.settings.signalLoops} times with the chart, then proclaims the winning guild when you close it.
      </p>
      {sig.id !== null && (
        <div className={ui.statGrid}>
          <Stat label="the word (console only)" value={o.signalWord ?? ''} />
          <Stat label="caught it" value={sig.correct} />
          <Stat label={sig.status === 'warned' ? 'goes live in' : sig.status === 'live' ? 'closes in' : 'winner'} value={sig.status === 'warned' && sig.fireAt ? <Countdown to={sig.fireAt} /> : sig.status === 'live' && sig.closesAt ? <Countdown to={sig.closesAt} /> : sig.winner ? GUILD_INFO[sig.winner].short : '-'} />
        </div>
      )}
      {!open && (
        <div className={ui.row}>
          <TextField label="warn, minutes ahead" type="number" min={0} max={60} value={String(mins)} onChange={(e) => setMins(Number(e.target.value))} />
          <TextField label="word (empty: we draw one)" value={word} maxLength={6} onChange={(e) => setWord(e.target.value.toUpperCase())} />
          <Button tone="sun" icon="bell" loading={act.isPending} onClick={() => act.mutate({ action: 'warn', inSec: Math.max(0, Math.round(mins * 60)), word: word || undefined })} data-testid="signal-warn">
            announce: fire in {mins} min
          </Button>
          <Button tone="pink" icon="bolt" loading={act.isPending} onClick={() => act.mutate({ action: 'fire', word: word || undefined })} data-testid="signal-fire">
            fire now
          </Button>
        </div>
      )}
      {open && (
        <div className={ui.row}>
          {sig.status === 'warned' && (
            <>
              <Button tone="pink" icon="bolt" loading={act.isPending} onClick={() => act.mutate({ action: 'fire' })} data-testid="signal-fire">
                fire it now
              </Button>
              <Button tone="paper" loading={act.isPending} onClick={() => act.mutate({ action: 'cancel' })}>
                call it off
              </Button>
            </>
          )}
          {sig.status === 'live' && (
            <Button tone="lime" icon="crown" loading={act.isPending} onClick={() => act.mutate({ action: 'close' })} data-testid="signal-close">
              close answers and crown the guild
            </Button>
          )}
        </div>
      )}
      {sig.status === 'closed' && !sig.word && (
        <Button tone="sun" icon="eye" loading={act.isPending} onClick={() => act.mutate({ action: 'reveal' })} data-testid="signal-reveal">
          reveal the word on every screen
        </Button>
      )}
    </Section>
  );
}

function Players({ o }: { o: CipherAdmin }) {
  const now = useServerNow(5000);
  return (
    <Section title={`players (${o.players.length})`} tilt={-0.2}>
      <div className={s.consoleTable}>
        <table className={ui.table} data-testid="cipher-players">
          <thead>
            <tr>
              <th>who</th>
              <th>set</th>
              <th>guild</th>
              <th>trial</th>
              <th>on it for</th>
              <th>stars</th>
              <th>points</th>
              <th>pact</th>
            </tr>
          </thead>
          <tbody>
            {o.players.map((p) => (
              <tr key={p.attendeeId} data-guild={p.guild}>
                <td>{p.nickname}</td>
                <td className={ui.num}>{pad3(p.serial)}</td>
                <td>
                  <span className={s.guildCell}>
                    <span className={s.dot} />
                    {GUILD_INFO[p.guild].short}
                  </span>
                </td>
                <td>{p.trial > TRIALS.length ? 'all sealed' : `${p.trial}. ${TRIAL_INFO[TRIALS[p.trial - 1]!].title}`}</td>
                <td className={ui.num}>{p.trial > TRIALS.length || p.trialStartedAt === null ? '' : mmss(now - p.trialStartedAt)}</td>
                <td className={ui.num}>{p.stars}</td>
                <td className={ui.num}>{p.points}</td>
                <td>{p.pact ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Pacts({ o, onDone }: { o: CipherAdmin; onDone: () => void }) {
  const toast = useToast();
  const now = useServerNow(5000);
  const brk = useMutation({ mutationFn: (id: number) => api.post(`/api/cipher/admin/pacts/${id}/break`, {}, CipherAdminSchema), onSuccess: onDone, onError: (e: Error) => toast(e.message, { kind: 'bad' }) });
  const open = o.pacts.filter((p) => p.status === 'open');
  const sealed = o.pacts.filter((p) => p.status === 'sealed').length;
  return (
    <Section title="pacts" tilt={0.2} action={<Stamp tone="info">{sealed} sealed</Stamp>}>
      <p className={ui.hand}>
        waiting for a partner: {o.waiting.length ? o.waiting.map((w) => `${w.nickname} (${GUILD_INFO[w.guild].short}, ${mmss(now - w.since)})`).join(', ') : 'nobody'}. after the wait, players can re-pair or come to the Oracle (print its ticket above).
      </p>
      <table className={ui.table} data-testid="cipher-pacts">
        <thead>
          <tr>
            <th>pact</th>
            <th>scanned</th>
            <th>open for</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {open.map((p) => (
            <tr key={p.id}>
              <td>
                {p.a} and {p.oracle ? 'the oracle' : p.b}
              </td>
              <td>
                {p.aScanned ? '✓' : '...'} / {p.bScanned ? '✓' : '...'}
              </td>
              <td className={ui.num}>{mmss(now - p.createdAt)}</td>
              <td>
                {!p.oracle && (
                  <Button tone="paper" size="sm" icon="users" onClick={() => brk.mutate(p.id)}>
                    re-pair both
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {open.length === 0 && (
            <tr>
              <td colSpan={4} className={ui.hand}>
                no open pacts
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Section>
  );
}

function Settings({ o, onSaved }: { o: CipherAdmin; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<CipherSettings>(o.settings);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(o.settings);
  }, [o.settings, dirty]);
  const save = useMutation({
    mutationFn: () => api.put('/api/cipher/admin/settings', draft, CipherAdminSchema),
    onSuccess: () => {
      setDirty(false);
      toast('saved. new values apply from the next attempt.', { kind: 'good' });
      onSaved();
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const set = (patch: Partial<CipherSettings>) => {
    setDirty(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  return (
    <Section title="difficulty" tilt={0.2} action={dirty ? <Stamp tone="late">unsaved</Stamp> : undefined}>
      <div className={s.settings} data-testid="cipher-settings">
        {NUMS.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <h3 className={s.settingsGroup}>{g.group}</h3>
            {g.items.map(([k, label]) => (
              <TextField key={k} label={label} type="number" step="any" value={String(draft[k])} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<CipherSettings>)} />
            ))}
            {g.group === 'the pact' && (
              <label className={s.checkLabel}>
                <input type="checkbox" checked={draft.pactOpen} onChange={(e) => set({ pactOpen: e.target.checked })} /> the pact is open
              </label>
            )}
          </div>
        ))}
        <h3 className={s.settingsGroup}>points</h3>
        {POINTS.map(([k, label]) => (
          <TextField key={k} label={label} type="number" value={String(draft.points[k])} onChange={(e) => set({ points: { ...draft.points, [k]: Number(e.target.value) } })} />
        ))}
        <h3 className={s.settingsGroup}>the oracle's ticket (private)</h3>
        {(['bottom', 'right', 'top', 'left'] as const).map((e) => (
          <TextField key={e} label={`${e} edge`} value={draft.oracle[e]} maxLength={6} onChange={(ev) => set({ oracle: { ...draft.oracle, [e]: ev.target.value.toUpperCase() } })} />
        ))}
      </div>
      <div className={ui.row}>
        <Button tone="lime" icon="check" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          save difficulty
        </Button>
        <Button
          tone="paper"
          disabled={!dirty}
          onClick={() => {
            setDirty(false);
            setDraft(o.settings);
          }}
        >
          undo changes
        </Button>
      </div>
    </Section>
  );
}

function OracleSheet({ onClose }: { onClose: () => void }) {
  const [words, setWords] = useState<{ bottom: string; right: string; top: string; left: string } | null>(null);
  useEffect(() => {
    void api.get('/api/cipher/admin/print', CipherPrintSchema).then((p) => setWords(p.oracle));
  }, []);
  if (!words) return null;
  const t = SLIP_SIZES.ticket;
  return <SlipSheet title="the oracle's ticket (keep it with the oracle)" slips={[{ strips: words, ticket: 'armillary', widthMm: t.widthMm, heightMm: t.heightMm, number: 'oracle', square: 'glyph' }]} onClose={onClose} />;
}

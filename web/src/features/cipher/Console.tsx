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
  PLAYED_TRIALS,
  TRIALS,
  TRIAL_INFO,
} from '@afterhours/shared/features/cipher';
import { HuntVisibilitySchema, SlipCopiesSchema } from '@afterhours/shared/features/hunt';
import { MORSE_RESET_PHRASE } from '@afterhours/shared/features/morse';
import { SLIP_SIZES } from '@afterhours/shared/morse-slip';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { SlipSheet } from '../../lib/slips';
import { Button, TextField, useToast } from '../../kit';
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

/**
 * The whole Morse game in two buttons (event day): "stop + reset" hides it from every phone, wipes all Cipher and
 * Morse progress (points and stickers too) and frees every claimed card set; "start" shows it again, fresh.
 * Same endpoints, same order as the organisers' runbook. Sign-ins, other points, mocktails and the gate stay.
 */
function GameControl({ o, onDone }: { o: CipherAdmin; onDone: () => void }) {
  const toast = useToast();
  const [arm, setArm] = useState(false);
  const [step, setStep] = useState('');
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 6000);
    return () => clearTimeout(t);
  }, [arm]);
  const stopReset = useMutation({
    mutationFn: async () => {
      setStep('hiding it from every phone...');
      await api.put('/api/hunt/admin/visibility', { morse: false }, HuntVisibilitySchema);
      setStep('wiping cipher progress...');
      await api.post('/api/cipher/admin/reset', { confirm: CIPHER_RESET_PHRASE }, OkSchema);
      setStep('wiping morse scores...');
      await api.post('/api/morse/admin/reset', { confirm: MORSE_RESET_PHRASE }, OkSchema);
      if (o.set) {
        const copies = await api.get(`/api/hunt/admin/slip-sets/${o.set.id}/copies`, SlipCopiesSchema);
        const claimed = copies.rows.map((r) => r.cells.find((c) => c.claimedBy)).filter((c): c is NonNullable<typeof c> => Boolean(c));
        let n = 0;
        for (const c of claimed) {
          setStep(`freeing card sets... ${++n}/${claimed.length}`);
          await api.post(`/api/hunt/admin/slip-copies/${c.copyId}/release`, {}, SlipCopiesSchema);
        }
      }
    },
    onSuccess: () => {
      setStep('');
      setArm(false);
      toast('Stopped and reset: hidden from phones, all progress wiped, every card set free.', { kind: 'good', title: 'morse game reset' });
      onDone();
    },
    onError: (e: Error) => {
      setStep('');
      toast(e.message, { kind: 'bad', title: 'reset stopped part way: tap it again' });
      onDone();
    },
  });
  const start = useMutation({
    mutationFn: () => api.put('/api/hunt/admin/visibility', { morse: true }, HuntVisibilitySchema),
    onSuccess: () => {
      toast('The Morse game is live on every phone.', { kind: 'good', title: 'started' });
      onDone();
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const busy = stopReset.isPending || start.isPending;
  return (
    <Section title="morse game: start, stop, reset" tape action={<Stamp tone={o.visible ? 'live' : 'done'}>{o.visible ? 'live' : 'stopped'}</Stamp>}>
      <p className={ui.hand}>
        {o.visible ? `live: ${o.players.length} playing, ${o.set?.claimed ?? 0} card sets claimed.` : `stopped: players can't see it. ${o.players.length} with progress, ${o.set?.claimed ?? 0} card sets claimed.`} stop + reset wipes every cipher and morse result and frees all card sets; sign-ins, other points, mocktails and the gate stay.
      </p>
      <div className={ui.row}>
        <Button tone="lime" size="lg" icon="play" disabled={busy || o.visible} loading={start.isPending} onClick={() => start.mutate()} data-testid="morse-game-start">
          {o.visible ? 'it is live' : 'start the game'}
        </Button>
        <Button tone="pink" size="lg" icon="lock" disabled={busy} loading={stopReset.isPending} onClick={() => (arm ? stopReset.mutate() : setArm(true))} data-testid="morse-game-stop-reset">
          {arm ? 'tap again: stop + wipe everything' : 'stop + reset'}
        </Button>
      </div>
      {step && <p className={ui.hand}>{step}</p>}
    </Section>
  );
}

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
      <GameControl o={o} onDone={() => void q.refetch()} />
      <Section
        title="the cipher"
        tape
        action={<Stamp tone={o.visible ? 'live' : 'done'}>{o.visible ? 'players see it' : 'hidden'}</Stamp>}
      >
        <div className={ui.statGrid}>
          <Stat label="sworn in" value={o.players.length} />
          <Stat label="sets claimed" value={o.set ? `${o.set.claimed}/${o.set.copies}` : 'no set'} />
          <Stat label="all six sealed" value={o.sealed[PLAYED_TRIALS.length - 1] ?? 0} />
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
        {PLAYED_TRIALS.map((t, i) => (
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
                <td>{p.trial > PLAYED_TRIALS.length ? 'all sealed' : `${p.trial}. ${TRIAL_INFO[TRIALS[p.trial - 1]!].title}`}</td>
                <td className={ui.num}>{p.trial > PLAYED_TRIALS.length || p.trialStartedAt === null ? '' : mmss(now - p.trialStartedAt)}</td>
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

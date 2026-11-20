/*
  Console: drops. The live drop (counter, cancel), the ready-made library (fire now, or in 5 minutes),
  a custom drop builder for every kind, scheduled/draft/past drops with who got them, the golden slip's
  printable QR, the live feed (mute, say something, hide a line) and the hype meter switches.
*/
import { OkSchema } from '@afterhours/shared';
import {
  AdminClaimsResponseSchema,
  type AdminDrop,
  AdminDropSchema,
  type DropKind,
  DropSettingsSchema,
  type DropsAdminState,
  type LibraryDrop,
  type RoomSizing,
} from '@afterhours/shared/features/drops';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { serverNow, useServerNow } from '../../core/clock';
import { Button, ErrorState, LoadingState, Modal, Qr, TextArea, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, ui } from '../common/ui';
import { dk, useDropsAdmin } from './api';
import s from './drops.module.css';

const KIND_LABEL: Record<DropKind, string> = { code: 'code drop', speed: 'speed question', golden: 'golden slip', room: 'everyone wins' };

function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: dk.admin }),
    onError: (e: Error) => toast(e.message, { kind: 'bad', title: 'did not work' }),
  }).mutate;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
const left = (ms: number) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function LiveNow({ st, act }: { st: DropsAdminState; act: ReturnType<typeof useAct> }) {
  const now = useServerNow(500);
  const live = st.drops.find((d) => d.status === 'live');
  if (!live) return null;
  const t = st.tally;
  return (
    <Section title="live now" tape action={<Stamp tone="live">{KIND_LABEL[live.kind]}</Stamp>}>
      <h3 className={ui.cardTitle}>{live.title}</h3>
      <div className={ui.statGrid}>
        <Stat label={live.opensAt && now < live.opensAt ? 'opens in' : 'left'} value={live.opensAt && now < live.opensAt ? left(live.opensAt - now) : left((live.closesAt ?? now) - now)} />
        {live.kind === 'room' ? <Stat label={`of ${live.goal}`} value={t?.count ?? 0} /> : <Stat label={live.slots ? `of ${live.slots} claimed` : 'right answers'} value={t?.claimed ?? 0} />}
        <Stat label="playing" value={t?.players ?? 0} />
      </div>
      {t && t.winners.length > 0 && <p className={ui.hand}>top: {t.winners.slice(0, 5).map((w) => `#${w.rank} ${w.nickname}`).join(', ')}</p>}
      <div className={ui.row}>
        <Button tone="pink" icon="close" onClick={() => confirm('Cancel the live drop? Nobody else can claim it. Points already won stay.') && act(() => api.post(`/api/drops/admin/${live.id}/cancel`, {}, AdminDropSchema))}>
          cancel it
        </Button>
      </div>
    </Section>
  );
}

function Library({ items, room, busy, act }: { items: LibraryDrop[]; room: RoomSizing; busy: boolean; act: ReturnType<typeof useAct> }) {
  return (
    <Section title="drop library" tilt={0.2}>
      <p className={ui.hand}>
        ready-made. "fire" starts the siren on every phone and the projector now. "in 5 min" teases phones first. winners and goals are sized for the <b>{room.present}</b> people signed in; build your own below to pick other numbers.
      </p>
      <ul className={s.lib}>
        {items.map((l) => (
          <li key={l.id} className={s.libCard} data-kind={l.input.config.kind}>
            <span className={s.libTag}>{l.tag}</span>
            <b className={s.libTitle}>{l.input.title}</b>
            <span className={s.libBlurb}>{l.input.blurb}</span>
            <span className={s.libMeta}>
              {l.input.durationSec}s
              {l.input.config.kind === 'code'
                ? `, code ${l.input.config.code}, first ${l.input.config.winners} win`
                : l.input.config.kind === 'golden'
                  ? `, word ${l.input.config.token}`
                  : l.input.config.kind === 'room'
                    ? `, goal ${l.input.config.goal}`
                    : ''}
            </span>
            <span className={ui.row}>
              <Button size="sm" tone="lime" icon="bolt" disabled={busy} onClick={() => act(() => api.post(`/api/drops/admin/library/${l.id}`, { when: 'now' }, AdminDropSchema))}>
                fire
              </Button>
              <Button size="sm" tone="paper" icon="clock" onClick={() => act(() => api.post(`/api/drops/admin/library/${l.id}`, { when: { at: Math.round(serverNow()) + 5 * 60_000 } }, AdminDropSchema))}>
                in 5 min
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

interface Form {
  kind: DropKind;
  title: string;
  blurb: string;
  duration: string;
  code: string;
  display: 'plain' | 'morse';
  winners: string;
  winPoints: string;
  restPoints: string;
  question: string;
  choices: string;
  correct: string;
  answers: string;
  topPoints: string;
  token: string;
  hint: string;
  bonus: string;
  goal: string;
  roomPoints: string;
  at: string;
}
const blank: Form = {
  kind: 'code',
  title: '',
  blurb: '',
  duration: '60',
  code: '',
  display: 'plain',
  winners: '20',
  winPoints: '15',
  restPoints: '3',
  question: '',
  choices: '',
  correct: '1',
  answers: '',
  topPoints: '30',
  token: '',
  hint: '',
  bonus: '50',
  goal: '200',
  roomPoints: '5',
  at: '',
};

function configOf(f: Form) {
  const n = (v: string) => Number(v) || 0;
  switch (f.kind) {
    case 'code':
      return { kind: 'code', code: f.code, display: f.display, winners: n(f.winners), winPoints: n(f.winPoints), restPoints: n(f.restPoints) };
    case 'speed': {
      const choices = f.choices
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean);
      return choices.length > 0
        ? { kind: 'speed', question: f.question, choices, correct: n(f.correct) - 1, topPoints: n(f.topPoints) }
        : { kind: 'speed', question: f.question, choices: [], answers: f.answers.split(',').map((a) => a.trim()).filter(Boolean), topPoints: n(f.topPoints) };
    }
    case 'golden':
      return { kind: 'golden', token: f.token, hint: f.hint, bonus: n(f.bonus) };
    default:
      return { kind: 'room', goal: n(f.goal), points: n(f.roomPoints) };
  }
}

function Builder({ room, act }: { room: RoomSizing; act: ReturnType<typeof useAct> }) {
  const sized = (): Form => ({ ...blank, winners: String(room.codeWinners), goal: String(room.roomGoal) });
  const [f, setF] = useState<Form>(sized);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const send = (when: 'now' | 'draft' | 'at') => {
    let w: unknown = when;
    if (when === 'at') {
      const t = new Date(f.at).getTime();
      if (!Number.isFinite(t)) return;
      w = { at: t };
    }
    act(async () => {
      await api.post('/api/drops/admin', { title: f.title, blurb: f.blurb, durationSec: Number(f.duration) || 60, config: configOf(f), when: w }, AdminDropSchema);
      setF((x) => ({ ...sized(), kind: x.kind }));
    });
  };
  return (
    <Section title="make your own" tilt={-0.2}>
      <div className={s.kinds} role="radiogroup" aria-label="kind">
        {(Object.keys(KIND_LABEL) as DropKind[]).map((k) => (
          <Button key={k} size="sm" tone={f.kind === k ? 'ink' : 'paper'} role="radio" aria-checked={f.kind === k} onClick={() => setF((x) => ({ ...x, kind: k }))}>
            {KIND_LABEL[k]}
          </Button>
        ))}
      </div>
      <div className={s.form}>
        <TextField label="title" value={f.title} onChange={set('title')} maxLength={60} placeholder="flash drop: ..." />
        <TextField label="blurb (phones and projector)" value={f.blurb} onChange={set('blurb')} maxLength={160} />
        <TextField label="window (seconds)" inputMode="numeric" value={f.duration} onChange={set('duration')} />
        {f.kind === 'code' && (
          <>
            <TextField label="the code" value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value.toUpperCase() }))} maxLength={12} />
            <label className={ui.label}>
              projector shows
              <select className={ui.select} value={f.display} onChange={(e) => setF((x) => ({ ...x, display: e.target.value as Form['display'] }))}>
                <option value="plain">the code</option>
                <option value="morse">its morse (decode it)</option>
              </select>
            </label>
            <TextField label="first N win" inputMode="numeric" value={f.winners} onChange={set('winners')} />
            <TextField label="winner points" inputMode="numeric" value={f.winPoints} onChange={set('winPoints')} />
            <TextField label="points for the rest" inputMode="numeric" value={f.restPoints} onChange={set('restPoints')} />
          </>
        )}
        {f.kind === 'speed' && (
          <>
            <TextField label="question" value={f.question} onChange={set('question')} maxLength={140} />
            <TextArea label="choices, one per line (blank = typed answer)" rows={4} value={f.choices} onChange={set('choices')} />
            {f.choices.trim() ? <TextField label="right choice (1-4)" inputMode="numeric" value={f.correct} onChange={set('correct')} /> : <TextField label="accepted answers, comma separated" value={f.answers} onChange={set('answers')} />}
            <TextField label="points for first" inputMode="numeric" value={f.topPoints} onChange={set('topPoints')} />
          </>
        )}
        {f.kind === 'golden' && (
          <>
            <TextField label="word on the slip" value={f.token} onChange={(e) => setF((x) => ({ ...x, token: e.target.value.toUpperCase() }))} maxLength={24} />
            <TextField label="hint" value={f.hint} onChange={set('hint')} maxLength={120} />
            <TextField label="bonus" inputMode="numeric" value={f.bonus} onChange={set('bonus')} />
          </>
        )}
        {f.kind === 'room' && (
          <>
            <TextField label="reactions + taps goal" inputMode="numeric" value={f.goal} onChange={set('goal')} />
            <TextField label="points each" inputMode="numeric" value={f.roomPoints} onChange={set('roomPoints')} />
          </>
        )}
      </div>
      <div className={ui.row}>
        <Button tone="lime" icon="bolt" disabled={!f.title.trim()} onClick={() => send('now')}>
          fire now
        </Button>
        <Button tone="paper" disabled={!f.title.trim()} onClick={() => send('draft')}>
          save draft
        </Button>
        <TextField label="or at" type="datetime-local" value={f.at} onChange={set('at')} />
        <Button tone="sky" icon="clock" disabled={!f.title.trim() || !f.at} onClick={() => send('at')}>
          schedule
        </Button>
      </div>
    </Section>
  );
}

function Claims({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['drops', 'claims', id], queryFn: () => api.get(`/api/drops/admin/${id}/claims`, AdminClaimsResponseSchema) });
  if (q.isPending) return <LoadingState label="loading..." />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (q.data.claims.length === 0) return <p className={ui.hand}>nobody tried this one.</p>;
  return (
    <table className={ui.table}>
      <thead>
        <tr>
          <th>#</th>
          <th>who</th>
          <th>right</th>
          <th>pts</th>
          <th>tries</th>
        </tr>
      </thead>
      <tbody>
        {q.data.claims.map((c, i) => (
          <tr key={i}>
            <td className={ui.num}>{c.rank ?? '-'}</td>
            <td>
              {c.nickname} <span className={ui.hand}>{c.kitId}</span>
            </td>
            <td>{c.correct ? 'yes' : 'no'}</td>
            <td className={ui.num}>{c.points}</td>
            <td className={ui.num}>{c.attempts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DropRow({ d, act }: { d: AdminDrop; act: ReturnType<typeof useAct> }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState(false);
  const golden = d.config.kind === 'golden' ? d.config.token : null;
  const goldenUrl = golden ? `${window.location.origin}/drop/g/${golden}` : '';
  return (
    <li className={s.row}>
      <div className={s.rowMain}>
        <Stamp tone={d.status === 'live' ? 'live' : d.status === 'scheduled' ? 'sky' : d.status === 'draft' ? 'info' : 'done'}>{d.status}</Stamp>
        <b>{d.title}</b>
        <span className={ui.hand}>
          {KIND_LABEL[d.kind]}
          {d.fireAt && d.status === 'scheduled' ? `, at ${clock(d.fireAt)}` : ''}
          {d.closedAt ? `, ${d.kind === 'room' ? `${d.count}/${d.goal}${d.achieved ? ' done' : ''}` : `${d.claimed} got it`}` : ''}
        </span>
      </div>
      <div className={ui.row}>
        {(d.status === 'draft' || d.status === 'scheduled') && (
          <>
            <Button size="sm" tone="lime" icon="bolt" onClick={() => act(() => api.post(`/api/drops/admin/${d.id}/fire`, {}, AdminDropSchema))}>
              fire
            </Button>
            <Button size="sm" tone="paper" icon="clock" onClick={() => act(() => api.post(`/api/drops/admin/${d.id}/schedule`, { at: Math.round(serverNow()) + 5 * 60_000 }, AdminDropSchema))}>
              in 5 min
            </Button>
          </>
        )}
        {d.status === 'scheduled' && (
          <Button size="sm" tone="paper" onClick={() => act(() => api.post(`/api/drops/admin/${d.id}/cancel`, {}, AdminDropSchema))}>
            unschedule
          </Button>
        )}
        {golden && (
          <Button size="sm" tone="sun" icon="qr" onClick={() => setQr(true)}>
            slip QR
          </Button>
        )}
        {(d.status === 'closed' || d.status === 'cancelled' || d.status === 'live') && (
          <Button size="sm" tone="paper" icon="users" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : 'who got it'}
          </Button>
        )}
        {d.status !== 'live' && <Button size="sm" tone="pink" icon="close" aria-label={`delete ${d.title}`} onClick={() => confirm(`Delete "${d.title}"? Points it paid stay.`) && act(() => api.del(`/api/drops/admin/${d.id}`, OkSchema))} />}
      </div>
      {open && <Claims id={d.id} />}
      <Modal open={qr} onClose={() => setQr(false)} title="golden slip QR">
        <div className={s.slipQr}>
          <Qr text={goldenUrl} size={240} label={`QR for ${golden}`} />
          <b className={s.slipWord}>{golden}</b>
          <p className={ui.hand}>print it, hide it. the phone camera opens the app and claims it. the word typed into the drop works too.</p>
          <Button tone="ink" icon="print" onClick={() => window.print()}>
            print
          </Button>
        </div>
      </Modal>
    </li>
  );
}

function Feed({ st, act }: { st: DropsAdminState; act: ReturnType<typeof useAct> }) {
  const [line, setLine] = useState('');
  const patch = (b: Record<string, unknown>) => act(() => api.patch('/api/drops/admin/settings', b, DropSettingsSchema));
  return (
    <Section title="live feed + hype" tilt={0.3}>
      <div className={ui.row}>
        <label className={ui.toggle}>
          <input type="checkbox" checked={!st.settings.feedMuted} onChange={(e) => patch({ feedMuted: !e.target.checked })} />
          feed on (home strip + projector ticker)
        </label>
        <label className={ui.toggle}>
          <input type="checkbox" checked={st.settings.hypeEnabled} onChange={(e) => patch({ hypeEnabled: e.target.checked })} />
          hype meter on the projector
        </label>
        <label className={ui.toggle}>
          <input type="checkbox" checked={st.settings.hypeAuto} onChange={(e) => patch({ hypeAuto: e.target.checked })} />
          auto "everyone wins" at max
        </label>
      </div>
      <div className={ui.statGrid}>
        <Stat label="activity a minute" value={st.hype.perMin} />
        <Stat label={`meter (fills at ${st.hype.target})`} value={`${Math.round(st.hype.level * 100)}%`} />
      </div>
      <div className={ui.row}>
        <label className={ui.toggle}>
          <input type="checkbox" checked={st.settings.hypeTargetAuto} onChange={(e) => patch({ hypeTargetAuto: e.target.checked })} />
          size the meter to the room ({st.room.hypeTarget} a minute for {st.room.present} people)
        </label>
        <TextField
          key={`${st.settings.hypeTarget}-${st.settings.hypeTargetAuto}`}
          label="or fill it at (a minute)"
          inputMode="numeric"
          defaultValue={st.settings.hypeTargetAuto ? '' : String(st.settings.hypeTarget)}
          placeholder={String(st.room.hypeTarget)}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 20 && n <= 5000 && (st.settings.hypeTargetAuto || n !== st.settings.hypeTarget)) patch({ hypeTarget: n });
          }}
        />
      </div>
      <form
        className={ui.row}
        onSubmit={(e) => {
          e.preventDefault();
          if (!line.trim()) return;
          act(() => api.post('/api/drops/admin/feed', { text: line.trim() }, OkSchema));
          setLine('');
        }}
      >
        <TextField label="say something in the feed" value={line} onChange={(e) => setLine(e.target.value)} maxLength={90} placeholder="chai is out at the atrium" />
        <Button type="submit" tone="sky" icon="megaphone" disabled={!line.trim()}>
          post
        </Button>
      </form>
      <ul className={s.feedAdmin}>
        {st.feed
          .slice()
          .reverse()
          .map((it) => (
            <li key={it.id} className={it.hidden ? s.hiddenLine : ''}>
              <span className={ui.hand}>{clock(it.at)}</span> {it.text}
              {!it.hidden && (
                <Button size="sm" tone="paper" onClick={() => act(() => api.post(`/api/drops/admin/feed/${it.id}/hide`, {}, OkSchema))}>
                  hide
                </Button>
              )}
            </li>
          ))}
        {st.feed.length === 0 && <li className={ui.hand}>quiet so far.</li>}
      </ul>
    </Section>
  );
}

function Danger({ act }: { act: ReturnType<typeof useAct> }) {
  const [typed, setTyped] = useState('');
  return (
    <Section title="danger zone" tilt={0.2}>
      <p className={ui.hand}>after the dry run: wipes every drop, claim and feed line, and takes drop points and stickers back.</p>
      <div className={ui.row}>
        <TextField label="type reset drops" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button tone="pink" disabled={typed !== 'reset drops'} onClick={() => (act(() => api.post('/api/drops/admin/reset', { confirm: 'reset drops' }, OkSchema)), setTyped(''))}>
          reset drops
        </Button>
      </div>
    </Section>
  );
}

export default function DropsConsole() {
  const q = useDropsAdmin();
  const act = useAct();
  if (q.isPending) return <LoadingState label="loading drops..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const st = q.data;
  const live = st.drops.some((d) => d.status === 'live');
  return (
    <div className={ui.stack}>
      <LiveNow st={st} act={act} />
      <Library items={st.library} room={st.room} busy={live} act={act} />
      <Builder room={st.room} act={act} />
      <Section title="drops" tilt={-0.3}>
        {st.drops.length === 0 ? (
          <p className={ui.hand}>nothing yet. fire one from the library.</p>
        ) : (
          <ul className={s.rows}>
            {st.drops.map((d) => (
              <DropRow key={d.id} d={d} act={act} />
            ))}
          </ul>
        )}
      </Section>
      <Feed st={st} act={act} />
      <Danger act={act} />
    </div>
  );
}

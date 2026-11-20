/*
  Console: trails. Pick a trail (treasure hunt, morse trail, slip trails...) or create one; set its
  order mode (shuffled with a fixed finale, fixed, graph), hints and cooldown; open/close it; edit
  its stops (riddle / scan / morse / slip, require-scan, online fallback, graph exits and finales);
  print its QR stickers and Morse cards; edit its slips; see its graph with live counts, the crowd,
  the progress table; reset it behind a typed confirmation.
*/
import { GlyphSchema, PaletteColorSchema } from '@afterhours/shared';
import {
  HUNT_CHALLENGES,
  HUNT_CONFIRM_RESET,
  type HuntAdmin,
  HuntAdminProgressSchema,
  HuntAdminSchema,
  type HuntAdminStop,
  type HuntChallenge,
  type HuntStopInput,
  SlipSetListSchema,
  TrailAdminListSchema,
  TrailGraphSchema,
  type TrailKind,
  type TrailOrderMode,
} from '@afterhours/shared/features/hunt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { fmtElapsed } from '../../core/time';
import { Button, IconButton, Meter, Sheet, Tabs, TextArea, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, ui } from '../common/ui';
import s from './hunt.module.css';
import { MorseCards, StickerSheet } from './Printables';
import { SlipEditor } from './SlipEditor';

const adminKey = (trail: number) => ['hunt', 'admin', trail] as const;
const CHALLENGE_LABEL: Record<HuntChallenge, string> = { riddle: 'riddle (typed answer)', scan: 'scan (QR only)', morse: 'morse (decode the object)', slip: 'slip (kit slip readings)' };
const ORDER_LABEL: Record<TrailOrderMode, string> = { shuffled: 'shuffled, same finale', fixed: 'fixed order', graph: 'graph (exits and slips pick the path)' };

interface Draft {
  id: number | null;
  title: string;
  clue: string;
  challenge: HuntChallenge;
  answers: string;
  hint1: string;
  hint2: string;
  points: number;
  glyph: HuntStopInput['glyph'];
  color: HuntStopInput['color'];
  reveal: string;
  location: string;
  requireScan: boolean;
  onlineFallback: boolean;
  slipId: number | null;
  nextStopId: number | null;
  finale: boolean;
}
const blank: Draft = {
  id: null,
  title: '',
  clue: '',
  challenge: 'riddle',
  answers: '',
  hint1: '',
  hint2: '',
  points: 10,
  glyph: 'star',
  color: 'tangerine',
  reveal: '',
  location: '',
  requireScan: false,
  onlineFallback: false,
  slipId: null,
  nextStopId: null,
  finale: false,
};
const draftOf = (st: HuntAdminStop): Draft => ({
  id: st.id,
  title: st.title,
  clue: st.clue,
  challenge: st.challenge,
  answers: st.answers.join(', '),
  hint1: st.hints[0] ?? '',
  hint2: st.hints[1] ?? '',
  points: st.points,
  glyph: st.glyph,
  color: st.color,
  reveal: st.reveal,
  location: st.location,
  requireScan: st.requireScan,
  onlineFallback: st.onlineFallback,
  slipId: st.slipId,
  nextStopId: st.nextStopId,
  finale: st.finale,
});

function useAdminAct(trail: number) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (f: () => Promise<HuntAdmin>) => f(),
    onSuccess: (d) => {
      qc.setQueryData(adminKey(trail), d);
      void qc.invalidateQueries({ queryKey: ['hunt', 'trails-admin'] });
      void qc.invalidateQueries({ queryKey: ['hunt', 'graph', trail] });
    },
    onError: (e) => toast(e.message, { kind: 'bad', title: 'nope' }),
  });
}

function StopEditor({ trail, draft, admin, onDone }: { trail: number; draft: Draft; admin: HuntAdmin; onDone: () => void }) {
  const [d, setD] = useState(draft);
  const act = useAdminAct(trail);
  const slips = useQuery({ queryKey: ['hunt', 'slips', trail], queryFn: () => api.get(`/api/hunt/admin/slip-sets?trail=${trail}`, SlipSetListSchema) });
  const graph = admin.trail.orderMode === 'graph';
  const body: HuntStopInput = {
    title: d.title,
    clue: d.clue,
    challenge: d.challenge,
    answers: d.challenge === 'scan' || d.challenge === 'slip' ? [] : d.answers.split(',').map((a) => a.trim()).filter(Boolean),
    hints: [d.hint1, d.hint2].map((h) => h.trim()).filter(Boolean),
    points: d.points,
    glyph: d.glyph,
    color: d.color,
    reveal: d.reveal,
    location: d.location,
    clueImage: null,
    requireScan: d.requireScan,
    onlineFallback: d.onlineFallback,
    slipId: d.challenge === 'slip' ? d.slipId : null,
    nextStopId: graph && d.challenge !== 'slip' ? d.nextStopId : null,
    finale: graph && d.finale,
  };
  const others = admin.stops.filter((x) => x.id !== d.id);
  return (
    <div className={ui.stack}>
      <label className={ui.label}>
        how is it solved
        <select className={ui.select} value={d.challenge} onChange={(e) => setD({ ...d, challenge: e.target.value as HuntChallenge })}>
          {HUNT_CHALLENGES.map((c) => (
            <option key={c} value={c}>
              {CHALLENGE_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <TextField label="title (attendees see it after solving)" value={d.title} maxLength={60} onChange={(e) => setD({ ...d, title: e.target.value })} />
      <TextArea label={d.challenge === 'morse' ? 'clue: where to look, what the object is' : 'clue'} value={d.clue} maxLength={400} onChange={(e) => setD({ ...d, clue: e.target.value })} />
      {d.challenge === 'riddle' && <TextField label="typed answers, comma separated" value={d.answers} onChange={(e) => setD({ ...d, answers: e.target.value })} />}
      {d.challenge === 'morse' && <TextField label="the word the morse spells (letters and digits)" value={d.answers} onChange={(e) => setD({ ...d, answers: e.target.value.toUpperCase() })} />}
      {d.challenge === 'slip' && (
        <label className={ui.label}>
          slip
          <select className={ui.select} value={d.slipId ?? ''} onChange={(e) => setD({ ...d, slipId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">pick a slip</option>
            {slips.data?.sets.flatMap((st) =>
              st.slips.map((sl) => (
                <option key={sl.id} value={sl.id}>
                  {st.title}: slip {sl.slipNo} {sl.label}
                </option>
              )),
            )}
          </select>
        </label>
      )}
      <div className={ui.row}>
        {(d.challenge === 'riddle' || d.challenge === 'morse') && (
          <label className={ui.toggle}>
            <input type="checkbox" checked={d.requireScan} onChange={(e) => setD({ ...d, requireScan: e.target.checked })} />
            must scan the object's QR first
          </label>
        )}
        {d.challenge === 'morse' && (
          <label className={ui.toggle}>
            <input type="checkbox" checked={d.onlineFallback} onChange={(e) => setD({ ...d, onlineFallback: e.target.checked })} />
            online fallback: the phone can play the morse
          </label>
        )}
      </div>
      {graph && (
        <div className={ui.row}>
          {d.challenge !== 'slip' && (
            <label className={ui.label}>
              once stamped, go to
              <select className={ui.select} value={d.nextStopId ?? ''} onChange={(e) => setD({ ...d, nextStopId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">nowhere (finale or dead end)</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.position}. {o.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={ui.toggle}>
            <input type="checkbox" checked={d.finale} onChange={(e) => setD({ ...d, finale: e.target.checked })} />
            finale: stamping this finishes the trail
          </label>
        </div>
      )}
      {admin.trail.hintsOn && (
        <>
          <TextField label="hint 1" value={d.hint1} maxLength={200} onChange={(e) => setD({ ...d, hint1: e.target.value })} />
          <TextField label="hint 2" value={d.hint2} maxLength={200} onChange={(e) => setD({ ...d, hint2: e.target.value })} />
        </>
      )}
      <TextField label="reveal after solving" value={d.reveal} maxLength={240} onChange={(e) => setD({ ...d, reveal: e.target.value })} />
      <TextField label="where it goes (organisers only)" value={d.location} maxLength={120} onChange={(e) => setD({ ...d, location: e.target.value })} />
      <div className={ui.row}>
        <TextField label="points" type="number" min={1} max={50} value={d.points} onChange={(e) => setD({ ...d, points: Number(e.target.value) })} />
        <label className={ui.label}>
          stamp
          <select className={ui.select} value={d.glyph} onChange={(e) => setD({ ...d, glyph: e.target.value as Draft['glyph'] })}>
            {GlyphSchema.options.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className={ui.label}>
          colour
          <select className={ui.select} value={d.color} onChange={(e) => setD({ ...d, color: e.target.value as Draft['color'] })}>
            {PaletteColorSchema.options.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={ui.row}>
        <Button
          tone="lime"
          icon="check"
          loading={act.isPending}
          disabled={!d.title.trim() || !d.clue.trim()}
          onClick={() =>
            act.mutate(() => (d.id === null ? api.post(`/api/hunt/admin/stops?trail=${trail}`, body, HuntAdminSchema) : api.put(`/api/hunt/admin/stops/${d.id}`, body, HuntAdminSchema)), {
              onSuccess: onDone,
            })
          }
        >
          save stop
        </Button>
        <Button tone="paper" ghost onClick={onDone}>
          cancel
        </Button>
      </div>
    </div>
  );
}

function NewTrail({ onCreated }: { onCreated: (id: number) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TrailKind>('morse');
  const [orderMode, setOrderMode] = useState<TrailOrderMode>('shuffled');
  const make = useMutation({
    mutationFn: () => api.post('/api/hunt/admin/trails', { title, kind, orderMode }, HuntAdminSchema),
    onSuccess: (a) => onCreated(a.trail.id),
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <div className={ui.stack}>
      <TextField label="trail name" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
      <div className={ui.row}>
        <label className={ui.label}>
          kind
          <select className={ui.select} value={kind} onChange={(e) => setKind(e.target.value as TrailKind)}>
            <option value="hunt">treasure hunt</option>
            <option value="morse">morse trail</option>
            <option value="other">other</option>
          </select>
        </label>
        <label className={ui.label}>
          order
          <select className={ui.select} value={orderMode} onChange={(e) => setOrderMode(e.target.value as TrailOrderMode)}>
            {(['shuffled', 'fixed', 'graph'] as const).map((m) => (
              <option key={m} value={m}>
                {ORDER_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button tone="lime" icon="plus" disabled={!title.trim()} loading={make.isPending} onClick={() => make.mutate()}>
        create trail
      </Button>
    </div>
  );
}

function Settings({ a }: { a: HuntAdmin }) {
  const act = useAdminAct(a.trail.id);
  const [title, setTitle] = useState(a.trail.title);
  const put = (body: object) => act.mutate(() => api.put(`/api/hunt/admin/trails/${a.trail.id}`, body, HuntAdminSchema));
  return (
    <div className={ui.row}>
      <TextField label="name" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== a.trail.title && put({ title })} />
      <label className={ui.label}>
        order
        <select className={ui.select} value={a.trail.orderMode} disabled={a.structureLocked} onChange={(e) => put({ orderMode: e.target.value })}>
          {(['shuffled', 'fixed', 'graph'] as const).map((m) => (
            <option key={m} value={m}>
              {ORDER_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <label className={ui.toggle}>
        <input type="checkbox" checked={a.trail.hintsOn} onChange={(e) => put({ hintsOn: e.target.checked })} />
        hints
      </label>
      <label className={ui.toggle}>
        <input type="checkbox" checked={a.trail.cooldownOn} onChange={(e) => put({ cooldownOn: e.target.checked })} />
        wrong-answer cooldown
      </label>
      {a.trail.orderMode !== 'graph' && a.stops.length > 2 && (
        <label className={ui.label}>
          each player gets
          <select
            className={ui.select}
            value={a.trail.subsetK > 0 && a.trail.subsetK < a.stops.length - 1 ? a.trail.subsetK : 0}
            disabled={a.structureLocked}
            onChange={(e) => put({ subsetK: Number(e.target.value) })}
            data-testid="trail-subset"
          >
            <option value={0}>every stop</option>
            {Array.from({ length: a.stops.length - 2 }, (_, i) => i + 1).map((k) => (
              <option key={k} value={k}>
                {k} of the {a.stops.length - 1} stops, then the finale
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function Graph({ trail }: { trail: number }) {
  const g = useQuery({ queryKey: ['hunt', 'graph', trail], queryFn: () => api.get(`/api/hunt/admin/graph?trail=${trail}`, TrailGraphSchema), refetchInterval: 5000 });
  if (!g.data) return null;
  const title = (id: number | null) => g.data.nodes.find((n) => n.stopId === id)?.title ?? '?';
  return (
    <div className={ui.stack}>
      {g.data.deadEnds.length > 0 && <p className={s.banner}>dead ends (no way out, not a finale): {g.data.deadEnds.map(title).join(', ')}</p>}
      <ol className={s.graph}>
        {g.data.nodes.map((n) => (
          <li key={n.stopId} className={s.graphNode}>
            <span className={s.graphTitle}>
              {n.start && <Stamp tone="live">start</Stamp>} {n.finale && <Stamp tone="late">finale</Stamp>} <b>{n.title}</b> <span className={ui.hand}>{n.challenge}, {n.hereNow} here, {n.solvedBy} stamped</span>
            </span>
            <ul className={s.graphEdges}>
              {g.data.edges
                .filter((e) => e.from === n.stopId)
                .map((e, i) => (
                  <li key={i}>
                    {e.kind === 'reading' ? e.label : 'stamped'} {e.to !== null ? `→ ${title(e.to)}` : e.toTrailId !== null ? `→ trail #${e.toTrailId}` : ''} <span className={s.edgeCount}>{e.count} {e.kind === 'reading' ? 'found it' : 'went'}</span>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

type View = 'stops' | 'slips' | 'graph' | 'people' | 'print';

export default function HuntConsole() {
  const qc = useQueryClient();
  const trails = useQuery({ queryKey: ['hunt', 'trails-admin'], queryFn: () => api.get('/api/hunt/admin/trails', TrailAdminListSchema), refetchInterval: 10_000 });
  const [trail, setTrail] = useState(1);
  const [view, setView] = useState<View>('stops');
  const [printing, setPrinting] = useState<'stickers' | 'cards' | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const admin = useQuery({ queryKey: adminKey(trail), queryFn: () => api.get(`/api/hunt/admin?trail=${trail}`, HuntAdminSchema), refetchInterval: 8000 });
  const progress = useQuery({ queryKey: ['hunt', 'progress', trail], queryFn: () => api.get(`/api/hunt/admin/progress?trail=${trail}`, HuntAdminProgressSchema), refetchInterval: 5000, enabled: view === 'people' });
  useLiveEvent('hunt.stamp', (d) => d.trailId === trail && void progress.refetch());
  useLiveEvent('hunt.state', () => void qc.invalidateQueries({ queryKey: ['hunt'] }));
  const act = useAdminAct(trail);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState('');
  const a = admin.data;
  if (printing === 'stickers') return <StickerSheet trail={trail} onClose={() => setPrinting(null)} />;
  if (printing === 'cards') return <MorseCards trail={trail} onClose={() => setPrinting(null)} />;
  const ids = a?.stops.map((x) => x.id) ?? [];
  const move = (i: number, dir: -1 | 1) => {
    const next = [...ids];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j] as number, next[i] as number];
    act.mutate(() => api.put(`/api/hunt/admin/order?trail=${trail}`, { ids: next }, HuntAdminSchema));
  };
  const crowdMax = Math.max(1, ...(progress.data?.crowd.map((c) => c.count) ?? [1]));
  const hasMorse = a?.stops.some((x) => x.challenge === 'morse') ?? false;
  return (
    <div className={ui.stack}>
      <Section title="trails" tape action={<Button size="sm" tone="lime" icon="plus" onClick={() => setNewOpen(true)}>new trail</Button>}>
        <div className={s.trailTabs}>
          {trails.data?.trails.map((tr) => (
            <button key={tr.id} type="button" className={`${s.trailTab} ${tr.id === trail ? s.trailTabOn : ''}`} onClick={() => setTrail(tr.id)}>
              <b>{tr.title}</b>
              <span className={ui.hand}>
                {tr.kind}, {tr.orderMode}, {tr.status}, {tr.stops} stops, {tr.players} playing
              </span>
            </button>
          ))}
        </div>
      </Section>

      {a && (
        <Section title={a.trail.title} tilt={0.2} action={<Stamp tone={a.status === 'open' ? 'live' : a.status === 'closed' ? 'done' : 'info'}>{a.status}</Stamp>}>
          <div className={ui.statGrid}>
            <Stat label="stops" value={a.stops.length} />
            <Stat label="started" value={a.players} />
            <Stat label="finished" value={a.finished} />
          </div>
          <Settings key={a.trail.id} a={a} />
          <div className={ui.row}>
            {a.status !== 'open' ? (
              <Button tone="lime" icon="play" onClick={() => act.mutate(() => api.put(`/api/hunt/admin/state?trail=${trail}`, { status: 'open' }, HuntAdminSchema))}>
                open this trail
              </Button>
            ) : (
              <Button tone="pink" icon="lock" onClick={() => act.mutate(() => api.put(`/api/hunt/admin/state?trail=${trail}`, { status: 'closed' }, HuntAdminSchema))}>
                close this trail
              </Button>
            )}
            <Button tone="sky" icon="print" onClick={() => setPrinting('stickers')}>
              QR stickers
            </Button>
            {hasMorse && (
              <Button tone="sky" icon="morse" onClick={() => setPrinting('cards')}>
                morse cards
              </Button>
            )}
          </div>
          <Tabs<View>
            value={view}
            onChange={setView}
            items={[
              { id: 'stops', label: 'stops', icon: 'list' },
              { id: 'slips', label: 'slips', icon: 'ticket' },
              { id: 'graph', label: 'graph', icon: 'map' },
              { id: 'people', label: 'progress', icon: 'users' },
              { id: 'print', label: 'reset', icon: 'close' },
            ]}
          />
        </Section>
      )}

      {a && view === 'stops' && (
        <Section title="stops" tilt={-0.2} action={<Button size="sm" tone="lime" icon="plus" disabled={a.structureLocked} onClick={() => setEdit(blank)}>add stop</Button>}>
          {a.structureLocked && <p className={s.banner}>people have started, so adding, deleting and reordering stops is locked. text and link edits are fine. reset the trail to restructure.</p>}
          {a.trail.orderMode === 'graph' && <p className={ui.hand}>graph trail: everyone starts at stop 1. each stop's exit (or a slip reading) says where to go next. stamping a finale finishes.</p>}
          <ol className={s.stops}>
            {a.stops.map((st, i) => (
              <li key={st.id} className={s.stop}>
                <span className={s.pos}>{st.position}</span>
                <span>
                  <b>{st.title}</b> <Stamp tone="sky">{st.challenge}</Stamp> {st.isFinal && <Stamp tone="late">finale</Stamp>} {st.requireScan && <Stamp tone="info">scan first</Stamp>} {st.onlineFallback && <Stamp tone="info">online</Stamp>}
                  <br />
                  <span className={ui.hand}>
                    {st.code}, {st.location || 'no location note'}, stamped by {st.solvedBy}, {st.hereNow} on it now
                    {a.trail.orderMode === 'graph' && st.nextStopId ? `, then ${a.stops.find((x) => x.id === st.nextStopId)?.title ?? '?'}` : ''}
                  </span>
                </span>
                <span className={ui.row}>
                  {!a.structureLocked && (
                    <>
                      <IconButton size="sm" icon="arrow" label="move up" style={{ transform: 'rotate(-90deg)' }} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton size="sm" icon="arrow" label="move down" style={{ transform: 'rotate(90deg)' }} disabled={i === ids.length - 1} onClick={() => move(i, 1)} />
                    </>
                  )}
                  <Button size="sm" tone="paper" onClick={() => setEdit(draftOf(st))}>
                    edit
                  </Button>
                  <IconButton size="sm" icon="undo" label="new QR token (old sticker stops working)" onClick={() => window.confirm('new QR for this stop? the old sticker stops working.') && act.mutate(() => api.post(`/api/hunt/admin/stops/${st.id}/rotate-token`, {}, HuntAdminSchema))} />
                  {!a.structureLocked && <IconButton size="sm" icon="close" label="delete stop" onClick={() => window.confirm(`delete "${st.title}"?`) && act.mutate(() => api.del(`/api/hunt/admin/stops/${st.id}`, HuntAdminSchema))} />}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {a && view === 'slips' && <SlipEditor trail={trail} stops={a.stops} trails={trails.data?.trails ?? []} />}
      {a && view === 'graph' && (
        <Section title="the trail as a graph" tilt={0.2}>
          <Graph trail={trail} />
        </Section>
      )}

      {a && view === 'people' && (
        <Section title="where the crowd is" tilt={-0.2}>
          {progress.data?.crowd.map((c) => (
            <div key={c.stopId} className={ui.stack}>
              <div className={ui.between}>
                <span>{c.title}</span>
                <span className={ui.num}>{c.count}</span>
              </div>
              <Meter value={c.count / crowdMax} tone="tangerine" label={c.title} />
            </div>
          ))}
          <table className={ui.table}>
            <thead>
              <tr>
                <th>who</th>
                <th>stamps</th>
                <th>on</th>
                <th>hints</th>
                <th>finish</th>
              </tr>
            </thead>
            <tbody>
              {progress.data?.rows.map((r) => (
                <tr key={r.attendeeId}>
                  <td>
                    <b>{r.nickname}</b> <span className={ui.hand}>{r.name}</span>
                  </td>
                  <td className={ui.num}>{r.solved}</td>
                  <td>{r.currentStopTitle ?? '-'}</td>
                  <td>{r.hintsUsed}</td>
                  <td>{r.rank ? `#${r.rank} in ${fmtElapsed(r.elapsedMs ?? 0)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {a && view === 'print' && (
        <Section title="danger zone" tilt={0.2}>
          <p className={ui.hand}>wipes this trail's starts, stamps, hints, slip finds and finishes, and takes back its points and stickers. stops and slips stay.</p>
          <div className={ui.row}>
            <TextField label={`type ${HUNT_CONFIRM_RESET}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button
              tone="pink"
              icon="close"
              disabled={confirm !== HUNT_CONFIRM_RESET}
              onClick={() => act.mutate(() => api.post(`/api/hunt/admin/reset?trail=${trail}`, { confirm: HUNT_CONFIRM_RESET }, HuntAdminSchema), { onSuccess: () => setConfirm('') })}
            >
              reset this trail
            </Button>
          </div>
        </Section>
      )}

      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit?.id === null ? 'new stop' : 'edit stop'}>
        {edit && a && <StopEditor trail={trail} draft={edit} admin={a} onDone={() => setEdit(null)} />}
      </Sheet>
      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="new trail">
        <NewTrail
          onCreated={(id) => {
            setNewOpen(false);
            setTrail(id);
            void qc.invalidateQueries({ queryKey: ['hunt', 'trails-admin'] });
          }}
        />
      </Sheet>
    </div>
  );
}

/*
  The flash-drop takeover on every phone. When a drop fires: a siren blip, haptics and a full-screen
  cut-paper card with a 3-2-1 on the server clock, then the play surface for its kind:
    code    type the code from the big screen (or decode its Morse); live "17/20 claimed"
    speed   tap a choice or type the answer, first right wins big
    golden  type the word on the golden slip (its QR opens /drop/g/<word> and claims by itself)
    room    one big shared button; the room fills the bar together
  Then the reveal and how you did. It can be tucked into a pill above the nav and brought back.
*/
import { type ClaimResponse, type CurrentDropResponse, type PublicDrop, ClaimResponseSchema, type DropTally, type MyClaim } from '@afterhours/shared/features/drops';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { api, isApiError } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { celebrate, haptics, sfx } from '../../fun';
import { Avatar, Button, Doodle, IconButton, Meter, NumberTicker } from '../../kit';
import { dk, useCurrentDrop } from './api';
import s from './drops.module.css';

/** Two-tone siren blip. Sound is optional: the takeover, the shake and the haptics carry it without. */
export function siren() {
  const notes = [880, 660, 880, 660];
  notes.forEach((f, i) => window.setTimeout(() => sfx.note(f, 120, 'square'), i * 150));
  haptics.celebrate();
}

const KIND_LABEL: Record<PublicDrop['kind'], string> = { code: 'code drop', speed: 'speed round', golden: 'golden slip', room: 'everyone wins' };
const KIND_TONE: Record<PublicDrop['kind'], string> = { code: 'var(--lime)', speed: 'var(--sky)', golden: 'var(--sun)', room: 'var(--pink)' };

type Phase = 'lead' | 'open' | 'done';
function phaseOf(d: PublicDrop, now: number): Phase {
  if (d.status !== 'live') return 'done';
  if (d.opensAt !== null && now < d.opensAt) return 'lead';
  if (d.closesAt !== null && now >= d.closesAt) return 'done';
  return 'open';
}

function secs(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}`;
}

export function Claimed({ tally, drop }: { tally: DropTally | null; drop: PublicDrop }) {
  if (!tally) return null;
  if (drop.kind === 'room') {
    const goal = tally.goal ?? drop.goal ?? 1;
    return (
      <div className={s.counter}>
        <Meter value={tally.count / goal} tone="pink" label="room progress" />
        <p className={s.counterText}>
          <b>
            <NumberTicker value={tally.count} />
          </b>
          /{goal} together
        </p>
      </div>
    );
  }
  if (drop.kind === 'code' && tally.slots) {
    return (
      <div className={s.counter}>
        <Meter value={tally.claimed / tally.slots} tone="lime" label="spots claimed" />
        <p className={s.counterText} aria-live="polite">
          <b>
            <NumberTicker value={Math.min(tally.claimed, tally.slots)} />
          </b>
          /{tally.slots} claimed
        </p>
      </div>
    );
  }
  return (
    <p className={s.counterText}>
      <b>{tally.players}</b> {tally.players === 1 ? 'person is' : 'people are'} in
    </p>
  );
}

function Answer({ drop, mine, onClaimed }: { drop: PublicDrop; mine: MyClaim | null; onClaimed: (r: ClaimResponse) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();
  const done = mine && (mine.outcome === 'won' || mine.outcome === 'bonus' || mine.outcome === 'already' || mine.outcome === 'out' || mine.outcome === 'too_slow');

  const send = async (answer: string) => {
    if (busy || !answer.trim()) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/drops/${drop.id}/claim`, { answer }, ClaimResponseSchema);
      onClaimed(r);
      setNote(r.message);
      if (r.outcome === 'wrong' || r.outcome === 'out' || r.outcome === 'too_slow') {
        sfx.fail();
        haptics.fail();
        if (!reduce && scope.current) void animate(scope.current, { x: [0, -12, 10, -7, 4, 0] }, { duration: 0.4 });
      }
      if (r.outcome === 'wrong') setText('');
    } catch (e) {
      setNote(isApiError(e) ? e.message : 'no connection. try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) return null;

  if (drop.kind === 'speed' && drop.choices && drop.choices.length > 0) {
    return (
      <div ref={scope} className={s.choices}>
        {drop.choices.map((c, i) => (
          <Button key={i} tone={(['sun', 'sky', 'pink', 'lime'] as const)[i % 4]} size="lg" block disabled={busy} onClick={() => void send(String(i))}>
            {c}
          </Button>
        ))}
        {note && <p className={s.note}>{note}</p>}
      </div>
    );
  }

  const label = drop.kind === 'golden' ? 'the word on the golden slip' : drop.kind === 'speed' ? 'your answer' : drop.display === 'morse' ? 'the decoded word' : 'the code on the big screen';
  return (
    <div ref={scope} className={s.answer}>
      <form
        className={s.answerRow}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <label className={s.answerLabel} htmlFor={`drop-${drop.id}`}>
          {label}
        </label>
        <input
          id={`drop-${drop.id}`}
          className={s.answerInput}
          value={text}
          onChange={(e) => setText(drop.kind === 'speed' ? e.target.value : e.target.value.toUpperCase())}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize={drop.kind === 'speed' ? 'off' : 'characters'}
          spellCheck={false}
          maxLength={40}
          enterKeyHint="send"
          autoFocus
        />
        <Button type="submit" tone="ink" size="lg" loading={busy} disabled={!text.trim()}>
          {drop.kind === 'golden' ? 'claim it' : 'send'}
        </Button>
      </form>
      {note && (
        <p className={s.note} role="status">
          {note}
        </p>
      )}
    </div>
  );
}

/** The room drop's shared button. Taps are counted locally for instant feedback and sent in small batches. */
function RoomButton({ drop }: { drop: PublicDrop }) {
  const pending = useRef(0);
  const [mine, setMine] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const iv = window.setInterval(() => {
      const n = Math.min(10, pending.current);
      if (n <= 0) return;
      pending.current -= n;
      void api.post(`/api/drops/${drop.id}/tap`, { n }, z.object({ count: z.number() })).catch(() => undefined);
    }, 350);
    return () => window.clearInterval(iv);
  }, [drop.id]);
  return (
    <div className={s.roomWrap}>
      <motion.button
        type="button"
        className={s.roomBtn}
        whileTap={reduce ? undefined : { scale: 0.9, rotate: -3 }}
        onClick={() => {
          pending.current = Math.min(40, pending.current + 1);
          setMine((m) => m + 1);
          sfx.pop();
          haptics.tap();
        }}
      >
        <Doodle name="flame" size={44} fill="var(--sun)" />
        <span>tap tap tap</span>
      </motion.button>
      <p className={s.fine}>{mine > 0 ? `you added ${mine}. reactions from the home bar count too.` : 'every tap and every reaction on the home bar counts.'}</p>
    </div>
  );
}

function Outcome({ drop, mine, tally }: { drop: PublicDrop; mine: MyClaim | null; tally: DropTally | null }) {
  const won = mine && (mine.outcome === 'won' || mine.outcome === 'bonus' || mine.outcome === 'already') && mine.points > 0;
  return (
    <div className={s.outcome}>
      {drop.kind === 'room' ? (
        <p className={s.big}>{drop.achieved ? 'the room did it!' : drop.status === 'live' ? 'keep going!' : 'so close. next time.'}</p>
      ) : won ? (
        <p className={s.big}>
          {mine.rank === 1 ? 'first!' : mine.outcome === 'won' ? `#${mine.rank}!` : 'got it!'} +{mine.points}
        </p>
      ) : mine?.outcome === 'out' ? (
        <p className={s.big}>out of tries</p>
      ) : drop.status === 'live' || drop.status === 'cancelled' ? null : (
        <p className={s.big}>{mine ? 'not this time' : 'missed it'}</p>
      )}
      {drop.status === 'cancelled' && <p className={s.reveal}>the organisers called this one off.{won ? ' your points stay.' : ''}</p>}
      {drop.reveal && (
        <p className={s.reveal}>
          it was <b>{drop.reveal}</b>
        </p>
      )}
      {tally && tally.winners.length > 0 && (
        <ol className={s.winners}>
          {tally.winners.slice(0, 3).map((w) => (
            <li key={`${w.rank}-${w.nickname}`}>
              <span className={s.winRank}>#{w.rank}</span>
              <Avatar config={w.avatar} size={30} />
              <b>{w.nickname}</b>
              <span className={s.winPts}>+{w.points}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Card({ data, onHide }: { data: CurrentDropResponse; onHide: () => void }) {
  const qc = useQueryClient();
  const drop = data.drop!;
  const now = useServerNow(200);
  const reduce = useReducedMotion();
  const phase = phaseOf(drop, now);
  const lastBeat = useRef<number | null>(null);

  // 3-2-1 ticks with a blip and a buzz each second of the lead.
  useEffect(() => {
    if (phase !== 'lead' || drop.opensAt === null) return;
    const n = Math.ceil((drop.opensAt - now) / 1000);
    if (lastBeat.current !== n) {
      lastBeat.current = n;
      sfx.tick();
      haptics.tick();
    }
  }, [phase, now, drop.opensAt]);
  useEffect(() => {
    if (phase === 'open') sfx.pop();
  }, [phase]);

  const onClaimed = useCallback(
    (r: ClaimResponse) => {
      qc.setQueryData<CurrentDropResponse>(dk.current, (old) => (old ? { ...old, mine: { outcome: r.outcome, rank: r.rank, points: r.points, attemptsLeft: r.attemptsLeft } } : old));
      if (r.outcome === 'won' || r.outcome === 'bonus') {
        celebrate({ y: 0.35 });
        sfx.fanfare();
        haptics.celebrate();
      }
      void qc.invalidateQueries({ queryKey: dk.current });
    },
    [qc],
  );

  const left = drop.closesAt !== null ? drop.closesAt - now : 0;
  return (
    <motion.div
      className={s.card}
      style={{ background: KIND_TONE[drop.kind] }}
      initial={reduce ? { opacity: 0 } : { y: 600, rotate: 12, scale: 0.7 }}
      animate={{ y: 0, rotate: 0, scale: 1, opacity: 1 }}
      exit={reduce ? { opacity: 0 } : { y: 600, rotate: -8 }}
      transition={{ type: 'spring', stiffness: 260, damping: 15 }}
    >
      <IconButton icon="close" label="tuck the drop away" size="sm" className={s.close} onClick={onHide} />
      <div className={s.head}>
        <span className={s.kind}>
          <Doodle name="bolt" size={20} fill="var(--sun)" /> {KIND_LABEL[drop.kind]}
        </span>
        {phase === 'open' && (
          <span className={`${s.clock} ${left < 10_000 ? s.clockHot : ''}`} aria-label={`${Math.ceil(left / 1000)} seconds left`}>
            {secs(left)}
          </span>
        )}
      </div>
      <h2 className={s.title}>{drop.title}</h2>
      {drop.blurb && <p className={s.blurb}>{drop.blurb}</p>}

      {phase === 'lead' && drop.opensAt !== null && (
        <AnimatePresence mode="popLayout">
          <motion.p
            key={Math.ceil((drop.opensAt - now) / 1000)}
            className={s.lead}
            initial={reduce ? { opacity: 0 } : { scale: 2.4, opacity: 0, rotate: -12 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={{ type: 'spring', stiffness: 520, damping: 18 }}
            aria-live="assertive"
          >
            {Math.max(1, Math.ceil((drop.opensAt - now) / 1000))}
          </motion.p>
        </AnimatePresence>
      )}

      {phase !== 'lead' && (
        <>
          {drop.kind === 'speed' && drop.question && <p className={s.question}>{drop.question}</p>}
          {drop.kind === 'golden' && drop.hint && (
            <p className={s.hint}>
              <Doodle name="eye" size={22} /> hint: {drop.hint}
            </p>
          )}
          {drop.kind === 'code' && phase === 'open' && <p className={s.hint}>{drop.display === 'morse' ? 'decode the dots and dashes on the big screen.' : 'look up at the big screen.'}</p>}
          <Claimed tally={data.tally} drop={drop} />
          {phase === 'open' && drop.kind === 'room' && <RoomButton drop={drop} />}
          {phase === 'open' && drop.kind !== 'room' && <Answer drop={drop} mine={data.mine} onClaimed={onClaimed} />}
          {(phase === 'done' || (data.mine && data.mine.outcome !== 'wrong')) && <Outcome drop={drop} mine={data.mine} tally={data.tally} />}
          {phase === 'done' && (
            <Button tone="ink" block onClick={onHide}>
              back to it
            </Button>
          )}
        </>
      )}
    </motion.div>
  );
}

export function DropOverlay() {
  const q = useCurrentDrop();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const now = useServerNow(1000);
  const data = q.data;
  const drop = data?.drop ?? null;

  useLiveEvent('drops.live', ({ drop: d }) => {
    siren();
    setSeen(d.id);
    setOpen(true);
  });
  useLiveEvent('drops.on-fire', () => {
    haptics.celebrate();
  });

  // Opening the app in the middle of a live drop you haven't finished brings it up once.
  useEffect(() => {
    if (drop && drop.status === 'live' && seen !== drop.id && !pathname.startsWith('/drop/g/')) {
      setSeen(drop.id);
      if (!data?.mine || data.mine.outcome === 'wrong') setOpen(true);
    }
  }, [drop, seen, data?.mine, pathname]);

  // A drop that closed while hidden doesn't come back; one that closed while open stays to show the reveal.
  const live = drop?.status === 'live' && (drop.closesAt === null || now < drop.closesAt);
  const showPill = Boolean(drop) && live && !open;
  useEffect(() => {
    if (!showPill || document.documentElement.dataset.dock) return;
    document.documentElement.dataset.dock = 'drop';
    return () => {
      if (document.documentElement.dataset.dock === 'drop') delete document.documentElement.dataset.dock;
    };
  }, [showPill]);

  if (!data || !drop) return null;
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div key="drop" className={s.takeover} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="dialog" aria-modal="true" aria-label={`flash drop: ${drop.title}`}>
            <Card data={data} onHide={() => setOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showPill && (
          <motion.button
            type="button"
            className={s.pill}
            initial={reduce ? { opacity: 0 } : { y: 60 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            onClick={() => setOpen(true)}
          >
            <Doodle name="bolt" size={22} fill="var(--sun)" /> a drop is live, tap in
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

/** /drop/g/<word>: a golden slip's QR opened by the phone camera. Claims once, then shows the takeover. */
export function GoldenLink() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useCurrentDrop();
  const [msg, setMsg] = useState<string>('checking the slip...');
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || !q.data) return;
    tried.current = true;
    const d = q.data.drop;
    if (!d || d.kind !== 'golden' || d.status !== 'live') {
      setMsg('no golden slip is loose right now. keep this one, maybe later.');
      return;
    }
    void api
      .post(`/api/drops/${d.id}/claim`, { answer: token }, ClaimResponseSchema)
      .then((r) => {
        setMsg(r.outcome === 'won' ? `you found it first! +${r.points}` : r.message);
        if (r.outcome === 'won') {
          celebrate({ y: 0.35 });
          sfx.fanfare();
          haptics.celebrate();
        } else {
          sfx.fail();
        }
        void qc.invalidateQueries({ queryKey: dk.current });
      })
      .catch((e: unknown) => setMsg(isApiError(e) ? e.message : 'no connection. type the word in the drop instead.'));
  }, [q.data, token, qc]);
  return (
    <div className={s.goldenPage}>
      <div className={s.card} style={{ background: 'var(--sun)' }}>
        <span className={s.kind}>
          <Doodle name="crown" size={22} fill="var(--paper-3)" /> golden slip
        </span>
        <h1 className={s.title}>{msg}</h1>
        <Button tone="ink" block onClick={() => nav('/', { replace: true })}>
          home
        </Button>
      </div>
    </div>
  );
}

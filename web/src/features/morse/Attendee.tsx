/*
  Morse on the phone (/morse).
  - Ladder map: decode and encode, 5 levels each, stamps for cleared, best score
    and how many others cleared it.
  - Decode: the word plays as beeps + screen flash + vibration (fully playable
    with sound off); type it into the letter boxes; letters flip right/wrong.
  - Encode: tap the word on the telegraph key; a live decode ribbon from the
    shared judgeTaps; results say "we read COD?" with a rhythm meter and pips.
  - Practice: tappable chart + a free key. Speed-round banner and live top 5.
*/
import {
  type LevelProgress,
  MORSE_CHART,
  MORSE_TABLE,
  type MorseMode,
  type MorseState,
  MorseStateSchema,
  type Press,
  type Round,
  type RoundResult,
  RoundResultSchema,
  RoundSchema,
  judgeTaps,
  patternToUnits,
  wordToPatterns,
} from '@afterhours/shared/features/morse';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { trailPath } from '@afterhours/shared/features/hunt';
import { useTrailVisibility, useTrails } from '../hunt/useHunt';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Countdown, ErrorState, LinkButton, LoadingState, Meter, NumberTicker, Sticker, Tabs, useToast } from '../../kit';
import { CipherMorseCard } from '../cipher/Attendee';
import { CodeBoxes } from '../common/CodeBoxes';
import { PageHead, Stamp, ui } from '../common/ui';
import { TelegraphKey } from './Key';
import s from './morse.module.css';
import { freeDecode, playSignal } from './signal';

export const morseKey = ['morse', 'state'] as const;

export function useMorse() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: morseKey, queryFn: () => api.get('/api/morse/state', MorseStateSchema), refetchInterval: 60_000 });
  useLiveEvent('morse.state', () => void qc.invalidateQueries({ queryKey: morseKey }));
  useLiveEvent('morse.sprint-board', (sprint) => qc.setQueryData<MorseState>(morseKey, (old) => (old ? { ...old, sprint } : old)));
  useLiveEvent('morse.sprint-ended', () => void qc.invalidateQueries({ queryKey: morseKey }));
  return q;
}

function Ladder({ st, onPlay }: { st: MorseState; onPlay: (mode: MorseMode, level: number) => void }) {
  const col = (mode: MorseMode, rows: LevelProgress[]) => (
    <div className={s.ladderCol}>
      <h3 className={s.ladderHead}>{mode === 'decode' ? 'listen + type' : 'tap it out'}</h3>
      {rows.map((p) => {
        const def = st.ladder[p.level - 1];
        return (
          <button key={p.level} type="button" className={`${s.rung} ${p.cleared ? s.rungDone : p.unlocked ? s.rungOpen : s.rungLocked}`} disabled={!p.unlocked || !st.enabled} onClick={() => onPlay(mode, p.level)}>
            {p.cleared ? <Sticker def={{ shape: 'burst', color: mode === 'decode' ? 'sky' : 'pink', glyph: 'wave' }} size={44} tilt={-8} /> : <span className={s.rungNum}>{p.level}</span>}
            <span className={s.rungText}>
              <b>{def?.title}</b>
              <small>
                {p.bestScore ? `best ${p.bestScore}` : p.unlocked ? 'play' : 'locked'}, {p.clearedByOthers} cleared
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div className={s.ladder}>
      {col('decode', st.decode)}
      {col('encode', st.encode)}
    </div>
  );
}

function ResultCard({ r, onAgain, onDone }: { r: RoundResult; onAgain: () => void; onDone: () => void }) {
  useEffect(() => {
    if (r.passed) celebrate({ y: 0.4 });
    else {
      sfx.fail();
      haptics.fail();
    }
  }, [r.passed]);
  return (
    <Card tone={r.passed ? 'lime' : 'pink'} tilt={-1} tape className={s.result}>
      <p className={ui.kicker}>{r.passed ? (r.firstClear ? 'level cleared!' : 'nice one') : r.over ? 'round over' : 'not quite'}</p>
      {r.decoded !== null && (
        <p className={s.weRead}>
          we read <b>{r.decoded || '...'}</b>
        </p>
      )}
      <div className={s.letters}>
        {r.letterOk.map((ok, i) => (
          <motion.span key={i} className={`${s.letter} ${ok ? s.letterOk : s.letterBad}`} initial={{ rotateY: 180 }} animate={{ rotateY: 0 }} transition={{ delay: i * 0.08 }}>
            {r.word?.[i] ?? (ok ? '✓' : '×')}
          </motion.span>
        ))}
      </div>
      {r.presses && (
        <div className={s.pips}>
          {r.presses.map((p, i) => (
            <span key={i} className={`${p.got === 'dah' ? s.dah : s.dit} ${Math.abs(Math.log(p.ratio)) < 0.25 ? s.pipGood : Math.abs(Math.log(p.ratio)) < 0.5 ? s.pipOk : s.pipOff}`} />
          ))}
        </div>
      )}
      {r.rhythm !== null && (
        <div className={`${ui.stack} ${s.wide}`}>
          <span className={ui.hand}>rhythm</span>
          <Meter value={r.rhythm} tone="sky" label="rhythm" />
        </div>
      )}
      <p className={s.score}>
        score <NumberTicker value={r.score} /> {r.pointsAwarded > 0 && <Stamp tone="ink">+{r.pointsAwarded}</Stamp>} {r.newBest && <Stamp tone="live">new best</Stamp>}
      </p>
      <p className={ui.hand}>{r.message}</p>
      <div className={ui.row}>
        {!r.over && (
          <Button tone="ink" onClick={onAgain}>
            try again ({r.attemptsLeft} left)
          </Button>
        )}
        <Button tone="paper" onClick={onDone}>
          back to the ladder
        </Button>
      </div>
    </Card>
  );
}

function DecodeRound({ round, onResult }: { round: Round; onResult: (r: RoundResult) => void }) {
  const [light, setLight] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const [guess, setGuess] = useState('');
  const [shake, setShake] = useState(0);
  const pb = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => pb.current?.stop(), []);
  const toast = useToast();
  const submit = useMutation({
    mutationFn: (g: string) => api.post(`/api/morse/rounds/${round.id}/guess`, { guess: g }, RoundResultSchema),
    onSuccess: (r) => {
      if (!r.passed) setShake((n) => n + 1);
      onResult(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const play = () => {
    if (!round.signal) return;
    pb.current?.stop();
    setPlaying(true);
    pb.current = playSignal(round.signal.segments, round.signal.leadInMs, setLight, () => {
      setPlaying(false);
      setPlayed(true);
    });
  };
  return (
    <div className={ui.stack}>
      <div className={`${s.flash} ${light ? s.flashOn : ''}`} aria-live="off">
        <span className={s.flashText}>{playing ? (light ? '' : 'listen...') : played ? 'what was it?' : 'ready?'}</span>
      </div>
      <Button tone="sky" icon="play" block onClick={play} disabled={playing}>
        {played ? 'play it again' : 'play the word'}
      </Button>
      <p className={ui.hand}>sound off? watch the flash and feel the buzz. short = dit, long = dah.</p>
      <CodeBoxes length={round.letters} value={guess} onChange={setGuess} shake={shake} label="your guess" alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" />
      <Button tone="lime" icon="check" block disabled={guess.length !== round.letters} loading={submit.isPending} onClick={() => submit.mutate(guess)}>
        that's my answer
      </Button>
    </div>
  );
}

function EncodeRound({ round, onResult }: { round: Round; onResult: (r: RoundResult) => void }) {
  const word = round.word ?? '';
  const [presses, setPresses] = useState<Press[]>([]);
  const [keyId, setKeyId] = useState(0);
  const toast = useToast();
  const live = presses.length ? judgeTaps(word, presses) : null;
  const submit = useMutation({
    mutationFn: () => api.post(`/api/morse/rounds/${round.id}/taps`, { presses }, RoundResultSchema),
    onSuccess: (r) => {
      setPresses([]);
      setKeyId((n) => n + 1);
      onResult(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <div className={ui.stack}>
      <div className={s.target}>
        {wordToPatterns(word).map((p, i) => (
          <span key={i} className={s.targetLetter}>
            <b>{word[i]}</b>
            <span className={s.targetCode}>
              {patternToUnits(p).map((u, j) => (j % 2 ? <i key={j} className={s.gapU} /> : <i key={j} className={u === 3 ? s.dah : s.dit} />))}
            </span>
          </span>
        ))}
      </div>
      <div className={s.ribbon} aria-live="polite">
        {live ? live.decoded || '...' : 'tap the key below'}
      </div>
      {live && live.presses.length > 0 && (
        <div className={s.pips} aria-hidden="true">
          {live.presses.map((p, i) => (
            <motion.span
              key={i}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              className={`${p.got === 'dah' ? s.dah : s.dit} ${Math.abs(Math.log(p.ratio)) < 0.25 ? s.pipGood : Math.abs(Math.log(p.ratio)) < 0.5 ? s.pipOk : s.pipOff}`}
            />
          ))}
        </div>
      )}
      <TelegraphKey key={keyId} onPress={(_, all) => setPresses(all)} />
      <div className={ui.row}>
        <Button tone="lime" icon="check" disabled={presses.length === 0} loading={submit.isPending} onClick={() => submit.mutate()}>
          send it
        </Button>
        <Button
          tone="paper"
          icon="undo"
          disabled={presses.length === 0}
          onClick={() => {
            setPresses([]);
            setKeyId((n) => n + 1);
          }}
        >
          start over
        </Button>
      </div>
    </div>
  );
}

function Practice() {
  const [light, setLight] = useState(false);
  const [presses, setPresses] = useState<Press[]>([]);
  const [keyId, setKeyId] = useState(0);
  const pb = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => pb.current?.stop(), []);
  const playChar = (code: string) => {
    pb.current?.stop();
    const segs: number[] = [];
    patternToUnits(code).forEach((u) => segs.push(u * 120));
    pb.current = playSignal(segs, 0, setLight, () => undefined);
  };
  return (
    <div className={ui.stack}>
      <div className={`${s.flash} ${s.flashSmall} ${light ? s.flashOn : ''}`} />
      <div className={s.chart}>
        {MORSE_CHART.map(({ char, code }) => (
          <button key={char} type="button" className={s.chartBtn} onClick={() => playChar(code)}>
            <b>{char}</b>
            <span>{code.replace(/\./g, '•').replace(/-/g, '—')}</span>
          </button>
        ))}
      </div>
      <h3 className={ui.cardTitle}>free key</h3>
      <div className={s.ribbon}>{freeDecode(presses, MORSE_TABLE) || 'tap anything'}</div>
      <TelegraphKey key={keyId} onPress={(_, all) => setPresses(all)} />
      <Button
        tone="paper"
        size="sm"
        icon="undo"
        onClick={() => {
          setPresses([]);
          setKeyId((n) => n + 1);
        }}
      >
        clear
      </Button>
    </div>
  );
}

function SprintBanner({ st }: { st: MorseState }) {
  if (!st.sprint) return null;
  const sp = st.sprint;
  return (
    <Card tone="pink" tilt={-1.2} tape tapeColor="sun" className={s.sprint}>
      <div className={ui.between}>
        <span className={ui.kicker}>speed round: {sp.sprint.mode}, level {sp.sprint.level}</span>
        <Countdown to={sp.sprint.endsAt} className={s.sprintClock} />
      </div>
      <ol className={s.top5}>
        {sp.top.slice(0, 5).map((r) => (
          <li key={r.attendeeId}>
            #{r.rank} {r.nickname} <b>{r.score}</b>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function MorsePage() {
  const q = useMorse();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'ladder' | 'practice'>('ladder');
  const [round, setRound] = useState<Round | null>(null);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (b: { mode: MorseMode; level: number; sprint?: boolean }) => api.post('/api/morse/rounds', b, RoundSchema),
    onSuccess: (r) => {
      setResult(null);
      setRound(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  useEffect(() => {
    // Pick up a round left open by a refresh, unless you bailed out of it.
    if (q.data?.openRound && !round && q.data.openRound.id !== left) setRound(q.data.openRound);
  }, [q.data?.openRound, round, left]);
  if (q.isPending) return <LoadingState label="warming up the wire..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const st = q.data;
  const done = () => {
    if (round) setLeft(round.id);
    setRound(null);
    setResult(null);
    void qc.invalidateQueries({ queryKey: morseKey });
  };
  return (
    <div className={ui.page}>
      <PageHead title="morse" note={`${st.players} ${st.players === 1 ? 'person has' : 'people have'} tried. you have ${st.morsePoints} morse points.`} color="var(--sky)" />
      {!st.enabled && <p className={s.off}>the online ladder is switched off right now. the organisers will open it.</p>}
      <CipherMorseCard />
      <TrailTeaser />
      <SprintBanner st={st} />
      {round ? (
        result ? (
          <ResultCard
            r={result}
            onAgain={() => setResult(null)}
            onDone={done}
          />
        ) : (
          <Card tone="paper" tilt={-0.5} tape className={ui.stack}>
            <div className={ui.between}>
              <Stamp tone={round.mode === 'decode' ? 'sky' : 'late'}>
                {round.mode} level {round.level}
              </Stamp>
              <span className={ui.hand}>
                <Countdown to={round.expiresAt} /> left
              </span>
            </div>
            {round.mode === 'decode' ? <DecodeRound round={round} onResult={setResult} /> : <EncodeRound round={round} onResult={setResult} />}
            <Button tone="paper" size="sm" ghost onClick={done}>
              bail out
            </Button>
          </Card>
        )
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: 'ladder', label: 'the ladder', icon: 'morse' },
              { id: 'practice', label: 'practice', icon: 'note' },
            ]}
          />
          {tab === 'ladder' ? (
            <>
              <Ladder st={st} onPlay={(mode, level) => start.mutate({ mode, level, sprint: Boolean(st.sprint && st.sprint.sprint.mode === mode && st.sprint.sprint.level === level) })} />
              {st.sprint && (
                <Button tone="pink" icon="bolt" block onClick={() => start.mutate({ mode: st.sprint!.sprint.mode, level: st.sprint!.sprint.level, sprint: true })}>
                  jump into the speed round
                </Button>
              )}
            </>
          ) : (
            <Practice />
          )}
        </>
      )}
    </div>
  );
}

/** The offline half of the challenge: your kit's morse slip (and any other Morse trail), when it is shown to players. */
function TrailTeaser() {
  const visible = useTrailVisibility().morse;
  const q = useTrails('morse', visible);
  if (!visible) return null;
  const open = (q.data?.trails ?? []).filter((t) => t.status === 'open' || t.started);
  if (open.length === 0) return null;
  return (
    <div className={ui.stack} data-testid="morse-trails">
      {open.map((t, i) => (
        <Card key={t.id} tone="sky" tilt={i % 2 ? -1 : 1.2} tape="left" tapeColor="sun" className={s.teaser}>
          <p className={s.teaserText}>
            {t.finishedRank ? `${t.title}: done, #${t.finishedRank}. nice ears.` : 'your kit has four morse tickets. their words are yours alone: scan them, turn them, decode them.'}
          </p>
          <LinkButton to={trailPath(t)} tone="ink" size="sm" icon="ticket">
            {t.title}
          </LinkButton>
        </Card>
      ))}
    </div>
  );
}

export function MorseHomeCard() {
  const q = useMorse();
  const slip = useTrailVisibility().morse;
  const st = q.data;
  if (!st || (!st.enabled && !slip)) return null;
  const cleared = st.decode.filter((p) => p.cleared).length + st.encode.filter((p) => p.cleared).length;
  return (
    <Card tone="sky" tilt={1} tape="left" tapeColor="pink" className={s.homeCard}>
      <div className={ui.between}>
        <span className={ui.kicker}>{st.sprint ? 'speed round is on!' : 'morse challenge'}</span>
        {st.enabled && <span className={s.homeCount}>{cleared}/10</span>}
      </div>
      <p className={s.homeCode}>-- --- .-. ... .</p>
      {slip && <p className={ui.hand}>your kit has four morse tickets with words nobody else has. decode them.</p>}
      <LinkButton to="/morse" tone="ink" size="sm" icon="morse">
        {st.enabled ? 'grab the key' : 'decode your tickets'}
      </LinkButton>
    </Card>
  );
}

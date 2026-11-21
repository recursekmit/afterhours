/*
  The Cipher Ticket on the phone (/morse/cipher): your four slips, your guild, a constellation of seven
  trials. Each trial has a one-line rule, a short drawn how-to and "N others on this trial"; the header
  keeps the trial clock, your streak and your cipher points. Playable with sound off (flash + buzz), and
  with reduced motion (the drawings hold still, the seal does not stamp).
*/
import {
  type CipherMe,
  EDGE_RUNE,
  type EchoResult,
  EchoResultSchema,
  GUILD_INFO,
  type GuessResult,
  GuessResultSchema,
  CipherMeSchema,
  type ScanResult,
  ScanResultSchema,
  TRIALS,
  TRIAL_INFO,
} from '@afterhours/shared/features/cipher';
import { MORSE_CHART, MORSE_TABLE, type Press } from '@afterhours/shared/features/morse';
import type { SlipEdge } from '@afterhours/shared/morse-slip';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { celebrate, haptics, sfx } from '../../fun';
import { type SlipScan, SlipScanLauncher, readingKey } from '../../lib/slips';
import { Avatar, Button, Card, Countdown, ErrorState, LinkButton, LoadingState, NumberTicker, TextField, WaxSeal, useToast } from '../../kit';
import { PageHead, Stamp, ui } from '../common/ui';
import { TelegraphKey } from '../morse/Key';
import { freeDecode, playSignal } from '../morse/signal';
import { mmss, pad3, useCipher, useSetMe } from './api';
import s from './cipher.module.css';
import { Compass } from './Compass';
import { Constellation } from './Constellation';
import { type HowKind, HowTo } from './HowTo';

const SEAL_GLYPH = ['key', 'arrow', 'wave', 'eye', 'note', 'heart', 'bolt'] as const;
const wind = (e: SlipEdge) => EDGE_RUNE[e].wind.replace('the ', '');
const EDGE_WORD: Record<SlipEdge, string> = { bottom: 'bottom', right: 'right', top: 'top', left: 'left' };

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export function CipherPage() {
  const q = useCipher();
  const me = q.data;
  const [sealing, setSealing] = useState<number | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!me?.ticket) return;
    // a trial was just sealed: the wax comes down
    if (last.current !== null && me.trial > last.current) setSealing(me.trial - 1);
    last.current = me.trial;
  }, [me?.trial, me?.ticket]);
  if (q.isPending) return <LoadingState label="lighting the candles..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const m = q.data;
  if (!m.visible || !m.ready) {
    return (
      <div className={ui.page}>
        <PageHead title="the cipher" color="var(--tangerine)" />
        <Card tone="ink" className={s.closed}>
          <WaxSeal glyph="lock" size={72} />
          <p className={ui.handBig}>{!m.visible ? 'the cipher is still sealed.' : 'the slips are not set up yet.'}</p>
          <p className={ui.hand}>keep your four slips safe. the organisers will open it.</p>
        </Card>
      </div>
    );
  }
  const guild = m.ticket ? GUILD_INFO[m.ticket.guild] : null;
  return (
    <div className={ui.page} data-guild={m.ticket?.guild ?? 'none'}>
      <PageHead title="the cipher" note={guild ? `set no. ${pad3(m.ticket!.serial)}, ${guild.title}` : 'four slips, seven trials, one guild'} color="var(--tangerine)" />
      {m.ticket && <Header me={m} />}
      <Constellation stars={m.stars} current={m.ticket ? m.trial : 1} />
      <Trial me={m} />
      <AnimatePresence>{sealing !== null && <SealOverlay key={sealing} trial={sealing} me={m} onDone={() => setSealing(null)} />}</AnimatePresence>
    </div>
  );
}

function Header({ me }: { me: CipherMe }) {
  const now = useServerNow(1000);
  const g = GUILD_INFO[me.ticket!.guild];
  const live = me.trial >= 2 && me.trial <= 6 && !me.nextSoon && me.trialStartedAt !== null;
  const elapsed = live ? now - me.trialStartedAt! : 0;
  const fast = elapsed <= me.parSec * 1000;
  return (
    <div className={s.header} data-guild={me.ticket!.guild}>
      <div className={s.guildPlaque} data-testid="guild-plaque">
        <span className={s.guildSwatch} aria-hidden="true" />
        <span>
          <b>{g.short}</b>
          <small>{g.colour} guild</small>
        </span>
      </div>
      <div className={s.headStat}>
        <NumberTicker value={me.points} className={s.headNum} />
        <small>points</small>
      </div>
      <div className={s.headStat}>
        <span className={s.headNum}>{me.streak}</span>
        <small>streak</small>
      </div>
      <div className={`${s.headStat} ${live ? (fast ? s.clockFast : s.clockSlow) : ''}`} data-testid="trial-clock">
        <span className={s.headNum}>{live ? mmss(elapsed) : '--'}</span>
        <small>{live ? (fast ? `bonus til ${mmss(me.parSec * 1000)}` : 'no rush now') : 'clock'}</small>
      </div>
    </div>
  );
}

function TrialCard({ me, n, children, how, edge }: { me: CipherMe; n: number; children: ReactNode; how?: HowKind; edge?: SlipEdge | null }) {
  const id = TRIALS[n - 1]!;
  const others = Math.max(0, (me.crowd[n - 1] ?? 0) - (me.ticket && me.trial === n ? 1 : 0));
  return (
    <Card tone="paper" className={s.trial} data-testid={`trial-${id}`}>
      <div className={ui.between}>
        <span className={ui.kicker}>
          trial {n} of 7: {TRIAL_INFO[id].title}
        </span>
        <Stamp tone="sky" rot={-3}>
          {others} {others === 1 ? 'other' : 'others'} here
        </Stamp>
      </div>
      <p className={s.rule}>{TRIAL_INFO[id].rule}</p>
      {how && <HowTo kind={how} edge={edge} />}
      {children}
    </Card>
  );
}

function Trial({ me }: { me: CipherMe }) {
  if (!me.ticket) return <Claim me={me} />;
  switch (me.trial) {
    case 1:
      return <Oath me={me} />;
    case 2:
      return <Winds me={me} />;
    case 3:
      return <Echo me={me} />;
    case 4:
      return <Whisper me={me} />;
    case 5:
      return <Riddle me={me} />;
    case 6:
      return me.nextSoon ? <Soon me={me} n={6} /> : <Pact me={me} />;
    case 7:
      return me.nextSoon ? <Soon me={me} n={7} /> : <Signal me={me} />;
    default:
      return <Done me={me} />;
  }
}

// ---------------------------------------------------------------------------
// scanning (claim, winds, the pact)
// ---------------------------------------------------------------------------

function useScan(onResult?: (r: ScanResult) => void) {
  const setMe = useSetMe();
  const toast = useToast();
  return useMutation({
    mutationFn: (read: { text?: string; morse?: string }) => api.post('/api/cipher/scan', read, ScanResultSchema),
    onSuccess: (r) => {
      setMe(r.me);
      if (r.outcome === 'rune' || r.outcome === 'claimed') {
        sfx.success();
        haptics.success();
      } else if (r.outcome === 'cursed') {
        sfx.note(110, 380, 'sawtooth');
        haptics.buzz([60, 40, 120, 40, 60]);
      } else {
        sfx.tap();
        haptics.tap();
      }
      onResult?.(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
}

function ScanBox({ label, hint, onRead, pending }: { label: string; hint: string; onRead: (read: { text?: string; morse?: string }) => void; pending: boolean }) {
  const [typed, setTyped] = useState('');
  return (
    <div className={ui.stack}>
      <SlipScanLauncher
        label={label}
        hint={hint}
        onScan={(scan: SlipScan) => {
          const k = readingKey(scan);
          if (k) onRead(k);
        }}
      />
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onRead({ text: typed.trim() });
          setTyped('');
        }}
      >
        <TextField label="or type the word you decoded" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" data-testid="cipher-type" />
        <Button tone="ink" type="submit" loading={pending} disabled={!typed.trim()}>
          read it
        </Button>
      </form>
    </div>
  );
}

function Outcome({ r }: { r: ScanResult | GuessResult | null }) {
  if (!r) return null;
  const good = 'outcome' in r ? ['rune', 'claimed', 'pact_half', 'pact_sealed'].includes(r.outcome) : r.correct;
  const cursed = 'outcome' in r && r.outcome === 'cursed';
  return (
    <motion.p key={r.message} className={`${s.outcome} ${good ? s.outcomeGood : cursed ? s.outcomeCursed : ''}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} role="status" data-testid="cipher-outcome">
      {r.message}
    </motion.p>
  );
}

// ---------------------------------------------------------------------------
// 1: claim + the oath
// ---------------------------------------------------------------------------

function Claim({ me }: { me: CipherMe }) {
  const [res, setRes] = useState<ScanResult | null>(null);
  const scan = useScan(setRes);
  return (
    <TrialCard me={me} n={1} how="turn">
      <p className={ui.hand}>your kit has four slips, I to IV. any edge of any one of them claims all four. the first scan wins them, so scan your own.</p>
      <ScanBox label="scan one of your slips" hint="hold a slip flat, any edge at the bottom" onRead={(r) => scan.mutate(r)} pending={scan.isPending} />
      <Outcome r={res} />
    </TrialCard>
  );
}

function Oath({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const g = GUILD_INFO[me.ticket!.guild];
  const reduce = useReducedMotion();
  const swear = useMutation({
    mutationFn: () => api.post('/api/cipher/oath', {}, CipherMeSchema),
    onSuccess: (m) => setMe(m),
  });
  return (
    <TrialCard me={me} n={1}>
      <motion.div className={s.oath} data-guild={me.ticket!.guild} initial={reduce ? false : { scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 16 }}>
        <WaxSeal glyph="key" size={88} press={!reduce} />
        <p className={s.oathKicker}>slip I is printed in {g.colour}. you are sworn into</p>
        <h2 className={s.oathGuild} data-testid="oath-guild">
          {g.title}
        </h2>
        <p className={s.oathLine}>&ldquo;{g.oath}&rdquo;</p>
        <Button tone="sun" icon="check" size="lg" loading={swear.isPending} onClick={() => swear.mutate()} data-testid="swear">
          i swear it
        </Button>
      </motion.div>
    </TrialCard>
  );
}

// ---------------------------------------------------------------------------
// 2: the four winds
// ---------------------------------------------------------------------------

function Winds({ me }: { me: CipherMe }) {
  const [res, setRes] = useState<ScanResult | null>(null);
  const [cursed, setCursed] = useState(false);
  const scan = useScan((r) => {
    setRes(r);
    if (r.outcome === 'cursed') setCursed(true);
  });
  const missing = (Object.keys(me.winds.found) as SlipEdge[]).filter((e) => !me.winds.found[e]);
  return (
    <TrialCard me={me} n={2} how="turn">
      <Compass found={me.winds.found} cursed={me.winds.cursed} flash={res?.edge ?? null} />
      {me.winds.hint >= 1 && (
        <p className={s.hint} data-testid="winds-hint">
          {me.winds.hint === 1 ? 'a hint: turn slip I all the way round. the top strip reads too, the right way up.' : `still missing: the ${missing.map((e) => `${EDGE_WORD[e]} (${wind(e)})`).join(', ')} of slip I.`}
        </p>
      )}
      <ScanBox label="scan slip I" hint="slip I, the edge you want at the bottom" onRead={(r) => scan.mutate(r)} pending={scan.isPending} />
      <Outcome r={res} />
      <AnimatePresence>{cursed && <Cursed onDone={() => setCursed(false)} />}</AnimatePresence>
    </TrialCard>
  );
}

function Cursed({ onDone }: { onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current(), 2600);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div className={s.cursed} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onDone} role="alert" data-testid="cursed">
      <svg viewBox="0 0 120 120" className={s.cursedGhost} aria-hidden="true">
        <path d="M60 14c-22 0-36 16-36 38v50l12-10 12 10 12-10 12 10 12-10 12 10V52c0-22-14-38-36-38z" />
        <circle cx={47} cy={52} r={6} className={s.cursedEye} />
        <circle cx={73} cy={52} r={6} className={s.cursedEye} />
      </svg>
      <p className={s.cursedText}>cursed!</p>
      <p className={s.cursedSub}>you read the north wind upside down. it still counts.</p>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// 3: the echo
// ---------------------------------------------------------------------------

/** Rough live pips: no expected word on the phone, so the unit is the shortest press. */
function livePips(presses: readonly Press[]): ('dit' | 'dah')[] {
  if (presses.length === 0) return [];
  const durs = presses.map(([d, u]) => u - d);
  const unit = Math.min(300, Math.max(50, Math.min(...durs)));
  return durs.map((d) => (d < 2 * unit ? 'dit' : 'dah'));
}

function Echo({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [presses, setPresses] = useState<Press[]>([]);
  const [keyId, setKeyId] = useState(0);
  const [res, setRes] = useState<EchoResult | null>(null);
  const edge = me.echo.edge;
  const send = useMutation({
    mutationFn: () => api.post('/api/cipher/echo', { presses }, EchoResultSchema),
    onSuccess: (r) => {
      setRes(r);
      setPresses([]);
      setKeyId((k) => k + 1);
      if (!r.passed) {
        sfx.fail();
        haptics.fail();
      }
      setTimeout(() => setMe(r.me), r.sealed ? 1400 : 0);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const pips = res && presses.length === 0 ? res.presses.map((p) => p.got) : livePips(presses);
  return (
    <TrialCard me={me} n={3} how="turn" edge={edge}>
      <div className={s.echoAsk}>
        <span className={s.slipBadge}>slip II</span>
        <p>
          turn slip II so its <b>{edge ? EDGE_WORD[edge] : '...'}</b> edge is at the bottom. decode that word ({me.echo.letters ?? 3} letters), then tap it below.
        </p>
      </div>
      <div className={s.letterSlots} aria-label={`${me.echo.letters ?? 3} letters`}>
        {Array.from({ length: me.echo.letters ?? 3 }, (_, i) => (
          <span key={i} className={`${s.slot} ${res ? (res.letterOk[i] ? s.slotOk : s.slotBad) : ''}`}>
            {res?.passed ? res.decoded[i] : res ? (res.decoded[i] ?? '?') : ''}
          </span>
        ))}
      </div>
      <div className={s.ribbon} aria-live="polite" data-testid="echo-ribbon">
        {presses.length ? freeDecode(presses, MORSE_TABLE) || '...' : res ? (res.passed ? res.decoded : `we read ${res.decoded || '...'}`) : 'tap the key'}
      </div>
      <div className={s.pips} aria-hidden="true">
        {pips.map((p, i) => (
          <motion.span key={`${keyId}-${i}`} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} className={`${p === 'dah' ? s.dah : s.dit} ${res && presses.length === 0 ? (Math.abs(Math.log(res.presses[i]?.ratio ?? 1)) < 0.25 ? s.pipGood : Math.abs(Math.log(res.presses[i]?.ratio ?? 1)) < 0.5 ? s.pipOk : s.pipOff) : ''}`} />
        ))}
      </div>
      <TelegraphKey key={keyId} onPress={(_, all) => setPresses(all)} />
      <div className={ui.row}>
        <Button tone="lime" icon="check" disabled={presses.length === 0} loading={send.isPending} onClick={() => send.mutate()} data-testid="echo-send">
          send it
        </Button>
        <Button
          tone="paper"
          icon="undo"
          disabled={presses.length === 0}
          onClick={() => {
            setPresses([]);
            setKeyId((k) => k + 1);
          }}
        >
          start over
        </Button>
        <span className={ui.hand}>{me.echo.triesLeft} {me.echo.triesLeft === 1 ? 'try' : 'tries'} left</span>
      </div>
      {res && (
        <p className={`${s.outcome} ${res.passed ? s.outcomeGood : ''}`} role="status" data-testid="cipher-outcome">
          {res.passed && <span className={s.starsInline}>{'★'.repeat(res.stars)}</span>} {res.message}
        </p>
      )}
      <MiniChart />
    </TrialCard>
  );
}

function MiniChart() {
  return (
    <details className={s.miniChart}>
      <summary>the chart</summary>
      <Chart compact />
    </details>
  );
}

function Chart({ compact }: { compact?: boolean }) {
  return (
    <div className={`${s.chart} ${compact ? s.chartCompact : ''}`} data-testid="morse-chart">
      {MORSE_CHART.filter((c) => /[A-Z]/.test(c.char)).map(({ char, code }) => (
        <span key={char} className={s.chartCell}>
          <b>{char}</b>
          <i>{code.replace(/\./g, '•').replace(/-/g, '—')}</i>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4: the whisper
// ---------------------------------------------------------------------------

function Whisper({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [light, setLight] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [plays, setPlays] = useState(0);
  const [guess, setGuess] = useState('');
  const [res, setRes] = useState<GuessResult | null>(null);
  const pb = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => pb.current?.stop(), []);
  const play = () => {
    const sig = me.whisper.signal;
    if (!sig) return;
    pb.current?.stop();
    setPlaying(true);
    pb.current = playSignal(sig.segments, sig.leadInMs, setLight, () => {
      setPlaying(false);
      setPlays((n) => n + 1);
    });
  };
  const hint = useMutation({ mutationFn: () => api.post('/api/cipher/whisper/hint', {}, CipherMeSchema), onSuccess: setMe, onError: (e) => toast(e.message, { kind: 'bad' }) });
  const answer = useMutation({
    mutationFn: () => api.post('/api/cipher/whisper', { guess }, GuessResultSchema),
    onSuccess: (r) => {
      setRes(r);
      if (r.correct) setTimeout(() => setMe(r.me), 1200);
      else {
        sfx.fail();
        haptics.fail();
      }
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const cost = me.whisper.hintCost;
  return (
    <TrialCard me={me} n={4} how="listen">
      <div className={`${s.flash} ${light ? s.flashOn : ''}`} data-testid="whisper-flash">
        <span className={s.flashText}>{playing ? (light ? '' : 'listen...') : plays ? 'what was it?' : 'ready when you are'}</span>
      </div>
      <Button tone="sky" icon="play" block onClick={play} disabled={playing} data-testid="whisper-play">
        {plays ? 'play it again (free)' : 'play the whisper'}
      </Button>
      <p className={ui.hand}>sound off? watch the flash and feel the buzz. slow letters, long gaps between them.</p>
      <Chart />
      <div className={ui.row}>
        {me.whisper.hintsUsed < 1 && (
          <Button tone="paper" size="sm" onClick={() => hint.mutate()} loading={hint.isPending}>
            first letter (-{cost})
          </Button>
        )}
        {me.whisper.hintsUsed === 1 && (
          <Button tone="paper" size="sm" onClick={() => hint.mutate()} loading={hint.isPending}>
            how many letters (-{cost})
          </Button>
        )}
        {me.whisper.firstLetter && <Stamp tone="info">starts with {me.whisper.firstLetter}</Stamp>}
        {me.whisper.letters && <Stamp tone="info">{me.whisper.letters} letters</Stamp>}
      </div>
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (guess.trim()) answer.mutate();
        }}
      >
        <TextField label="the whisper says" value={guess} onChange={(e) => setGuess(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" maxLength={8} data-testid="whisper-guess" />
        <Button tone="lime" type="submit" icon="check" loading={answer.isPending} disabled={!guess.trim()}>
          answer
        </Button>
      </form>
      <Outcome r={res} />
    </TrialCard>
  );
}

// ---------------------------------------------------------------------------
// 5: the riddle (slip III)
// ---------------------------------------------------------------------------

function Riddle({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [notes, setNotes] = useState<Record<SlipEdge, string>>({ top: '', right: '', bottom: '', left: '' });
  const [guess, setGuess] = useState('');
  const [res, setRes] = useState<GuessResult | null>(null);
  const hint = useMutation({ mutationFn: () => api.post('/api/cipher/riddle/hint', {}, CipherMeSchema), onSuccess: setMe, onError: (e) => toast(e.message, { kind: 'bad' }) });
  const answer = useMutation({
    mutationFn: () => api.post('/api/cipher/riddle', { guess }, GuessResultSchema),
    onSuccess: (r) => {
      setRes(r);
      if (r.correct) setTimeout(() => setMe(r.me), 1200);
      else {
        sfx.fail();
        haptics.fail();
      }
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const first = me.riddle.rule !== 'last';
  return (
    <TrialCard me={me} n={5} how="sort">
      <div className={s.riddleBox}>
        <span className={s.slipBadge}>slip III</span>
        <p className={s.riddleText} data-testid="riddle-text">
          four winds, four words. put them in order from a to z: the one that comes <b>{first ? 'first' : 'last'}</b> opens the way.
        </p>
      </div>
      <p className={ui.hand}>your notes (they stay on this phone). a scan fills in the edge it read.</p>
      <div className={s.notes}>
        {(['top', 'right', 'bottom', 'left'] as SlipEdge[]).map((e) => (
          <TextField key={e} label={`${EDGE_WORD[e]} (${EDGE_RUNE[e].compass})`} value={notes[e]} onChange={(ev) => setNotes((n) => ({ ...n, [e]: ev.target.value.toUpperCase() }))} autoComplete="off" maxLength={6} className={me.riddle.hintEdge === e ? s.noteHint : undefined} />
        ))}
      </div>
      <SlipScanLauncher
        label="scan slip III"
        hint="slip III: the strip at the bottom is read, decoded on your phone"
        onScan={(scan) => {
          const text = scan.primary?.text;
          if (!text) return;
          // the scanner cannot tell which edge it is; fill the first empty note
          setNotes((n) => {
            if (Object.values(n).includes(text)) return n;
            const free = (['bottom', 'right', 'top', 'left'] as SlipEdge[]).find((e) => !n[e]);
            return free ? { ...n, [free]: text } : n;
          });
        }}
      />
      <div className={ui.row}>
        {!me.riddle.hintUsed ? (
          <Button tone="paper" size="sm" onClick={() => hint.mutate()} loading={hint.isPending}>
            which edge? (-{me.riddle.hintCost})
          </Button>
        ) : (
          me.riddle.hintEdge && <Stamp tone="info">it is on the {EDGE_WORD[me.riddle.hintEdge]} edge</Stamp>
        )}
      </div>
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (guess.trim()) answer.mutate();
        }}
      >
        <TextField label="the answer" value={guess} onChange={(e) => setGuess(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" maxLength={8} data-testid="riddle-guess" />
        <Button tone="lime" type="submit" icon="check" loading={answer.isPending} disabled={!guess.trim()}>
          answer
        </Button>
      </form>
      <Outcome r={res} />
      <MiniChart />
    </TrialCard>
  );
}

// ---------------------------------------------------------------------------
// 6: the pact (slip IV)
// ---------------------------------------------------------------------------

function Pact({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const toast = useToast();
  const now = useServerNow(1000);
  const [res, setRes] = useState<ScanResult | null>(null);
  const scan = useScan(setRes);
  const act = useMutation({
    mutationFn: (what: 'repair' | 'oracle') => api.post(`/api/cipher/pact/${what}`, {}, CipherMeSchema),
    onSuccess: (m) => {
      setRes(null);
      setMe(m);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const p = me.pact;
  const waitedFor = p.since !== null ? now - p.since : 0;
  const pg = p.partner ? GUILD_INFO[p.partner.guild] : null;
  return (
    <TrialCard me={me} n={6} how="swap">
      {p.status === 'waiting' && (
        <div className={s.pactWait} data-testid="pact-waiting">
          <WaxSeal glyph="heart" size={64} />
          <p className={ui.handBig}>finding you someone from another guild...</p>
          <p className={ui.hand}>
            {p.waiting} waiting for a pact. {mmss(waitedFor)} so far. keep slip IV in your hand.
          </p>
        </div>
      )}
      {(p.status === 'paired' || p.status === 'oracle') && (
        <>
          <div className={s.partner} data-guild={p.partner?.guild ?? 'armillary'} data-testid="pact-partner">
            {p.partner ? <Avatar config={p.partner.avatar} size={72} /> : <WaxSeal glyph="eye" size={64} />}
            <div>
              <p className={s.partnerName}>{p.partner ? p.partner.nickname : 'the Oracle'}</p>
              <p className={s.partnerGuild}>
                <span className={s.dot} /> {pg ? `${pg.title}, ${pg.colour}` : 'an organiser with the Oracle’s ticket. ask at the desk.'}
              </p>
            </div>
          </div>
          <div className={s.pactSteps}>
            <p className={`${s.pactStep} ${p.iScanned ? s.pactDone : ''}`} data-testid="pact-you">
              <span className={s.slipBadge}>{p.iScanned ? '✓' : '1'}</span>
              <span>
                scan {p.partner ? 'their slip IV' : 'the Oracle’s ticket'} with its <b>{p.scanEdge}</b> edge at the bottom.
              </span>
            </p>
            {p.status === 'paired' && (
              <p className={`${s.pactStep} ${p.theyScanned ? s.pactDone : ''}`} data-testid="pact-them">
                <span className={s.slipBadge}>{p.theyScanned ? '✓' : '2'}</span>
                <span>
                  hold out your slip IV: they read your <b>{p.showEdge}</b> edge.
                </span>
              </p>
            )}
          </div>
          {!p.iScanned && <ScanBox label={p.partner ? 'scan their slip IV' : 'scan the oracle'} hint={`the ${p.scanEdge} edge at the bottom`} onRead={(r) => scan.mutate(r)} pending={scan.isPending} />}
        </>
      )}
      <Outcome r={res} />
      {p.canRepair && (
        <div className={ui.row} data-testid="pact-options">
          <p className={ui.hand}>no luck yet? no harm done.</p>
          {p.status === 'paired' && (
            <Button tone="paper" size="sm" icon="users" loading={act.isPending} onClick={() => act.mutate('repair')}>
              find someone else
            </Button>
          )}
          <Button tone="sun" size="sm" icon="eye" loading={act.isPending} onClick={() => act.mutate('oracle')} data-testid="pact-oracle">
            go to the oracle
          </Button>
        </div>
      )}
    </TrialCard>
  );
}

// ---------------------------------------------------------------------------
// next soon, done
// ---------------------------------------------------------------------------

function Soon({ me, n }: { me: CipherMe; n: number }) {
  const over = n === 7 && me.signal.status === 'closed';
  return (
    <TrialCard me={me} n={n}>
      <div className={s.soon} data-testid="next-soon">
        <WaxSeal glyph={over ? 'bolt' : 'clock'} size={64} />
        <p className={ui.handBig}>{over ? 'the last signal has been sent.' : 'next trials open soon.'}</p>
        <p className={ui.hand}>
          {over
            ? me.signal.winner
              ? `${GUILD_INFO[me.signal.winner].title} won the race.${me.signal.word ? ` the word was ${me.signal.word}.` : ''}`
              : 'the result shows here in a moment.'
            : n === 6
              ? 'keep slip IV handy: someone from another guild will need it.'
              : 'keep your phone in hand: when the organisers fire the last signal, it beeps your own word.'}
        </p>
      </div>
    </TrialCard>
  );
}

// ---------------------------------------------------------------------------
// 7: the last signal
// ---------------------------------------------------------------------------

function Signal({ me }: { me: CipherMe }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [guess, setGuess] = useState('');
  const [res, setRes] = useState<GuessResult | null>(null);
  const [light, setLight] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [plays, setPlays] = useState(0);
  const pb = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => pb.current?.stop(), []);
  const sig = me.signal;
  const play = () => {
    const p = sig.play;
    if (!p) return;
    pb.current?.stop();
    setPlaying(true);
    pb.current = playSignal(p.segments, p.leadInMs, setLight, () => {
      setPlaying(false);
      setPlays((n) => n + 1);
    });
  };
  const answer = useMutation({
    mutationFn: () => api.post('/api/cipher/signal', { guess }, GuessResultSchema),
    onSuccess: (r) => {
      setRes(r);
      if (r.correct) setTimeout(() => setMe(r.me), 1400);
      else {
        sfx.fail();
        haptics.fail();
      }
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <TrialCard me={me} n={7} how="listen">
      {sig.status === 'warned' && sig.fireAt !== null && (
        <div className={s.soon} data-testid="signal-warned">
          <p className={ui.handBig}>the last signal goes out in</p>
          <Countdown to={sig.fireAt} className={s.bigCount} />
          <p className={ui.hand}>keep your phone in hand, sound up. when it goes out, your phone beeps, flashes and buzzes your own word: nobody else has the same one. {sig.firstN > 1 ? `the first ${sig.firstN} to type theirs win big.` : ''}</p>
        </div>
      )}
      {sig.status === 'live' && (
        <>
          <div className={s.signalLive} data-testid="signal-live">
            <span className={s.liveDot} aria-hidden="true" />
            <p>
              <b>the last signal is live.</b> your word has {sig.letters} letters. {sig.correct} caught theirs so far.
            </p>
          </div>
          <div className={`${s.flash} ${light ? s.flashOn : ''}`} data-testid="signal-flash">
            <span className={s.flashText}>{playing ? (light ? '' : 'listen...') : plays ? 'what was it?' : 'tap play: it is your word alone'}</span>
          </div>
          <Button tone="pink" icon="play" block onClick={play} disabled={playing || !sig.play} data-testid="signal-play">
            {plays ? 'play it again' : 'play the last signal'}
          </Button>
          <form
            className={s.typeRow}
            onSubmit={(e) => {
              e.preventDefault();
              if (guess.trim()) answer.mutate();
            }}
          >
            <TextField label="the last signal says" value={guess} onChange={(e) => setGuess(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" maxLength={8} data-testid="signal-guess" />
            <Button tone="lime" type="submit" icon="check" loading={answer.isPending} disabled={!guess.trim()}>
              send
            </Button>
          </form>
          <Outcome r={res} />
          <MiniChart />
        </>
      )}
    </TrialCard>
  );
}

function Done({ me }: { me: CipherMe }) {
  return (
    <Card tone="ink" className={s.closed} data-testid="cipher-done">
      <WaxSeal glyph="crown" size={80} />
      <p className={ui.handBig}>all seven trials sealed.</p>
      {me.signal.answered && <p className={s.cardTitle}>#{me.signal.answered.rank} on the last signal</p>}
      <p className={ui.hand}>
        {me.points} cipher points for {GUILD_INFO[me.ticket!.guild].title}.
      </p>
      {me.signal.winner && <p className={ui.hand}>{GUILD_INFO[me.signal.winner].title} won the race.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// the seal coming down
// ---------------------------------------------------------------------------

function SealOverlay({ trial, me, onDone }: { trial: number; me: CipherMe; onDone: () => void }) {
  const reduce = useReducedMotion();
  const st = me.stars[trial - 1];
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // once per seal: parent re-renders must not restart the sparks or the timer
    celebrate({ y: 0.4 });
    haptics.celebrate();
    const t = setTimeout(() => done.current(), 2600);
    return () => clearTimeout(t);
  }, []);
  const id = TRIALS[trial - 1]!;
  return (
    <motion.div className={s.sealOverlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onDone} role="status" data-testid="seal-overlay">
      <motion.div initial={reduce ? false : { scale: 2.4, rotate: -20, y: -60 }} animate={{ scale: 1, rotate: -6, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
        <WaxSeal glyph={SEAL_GLYPH[trial - 1] ?? 'star'} size={132} press={!reduce} />
      </motion.div>
      <p className={s.sealTitle}>{TRIAL_INFO[id].title} sealed</p>
      <p className={s.sealStars} aria-label={`${st?.stars ?? 0} stars`}>
        {[0, 1, 2].map((k) => (
          <span key={k} className={k < (st?.stars ?? 0) ? s.sealStarOn : s.sealStarOff}>
            {'★'}
          </span>
        ))}
      </p>
      {st && st.points > 0 && <p className={s.sealPoints}>+{st.points}</p>}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// the Morse page's card and the home card
// ---------------------------------------------------------------------------

export function CipherMorseCard() {
  const q = useCipher();
  const m = q.data;
  if (!m?.visible || !m.ready) return null;
  const sealed = m.stars.filter((x) => x.sealedAt).length;
  return (
    <Card tone="tangerine" className={s.morseCard} data-testid="cipher-card">
      <div className={ui.between}>
        <span className={ui.kicker}>the main event</span>
        <span className={s.cardCount}>{sealed}/7</span>
      </div>
      <h2 className={s.cardTitle}>the cipher</h2>
      <p className={ui.hand}>{m.ticket ? `${GUILD_INFO[m.ticket.guild].title}, trial ${Math.min(m.trial, 7)} of 7.` : 'four slips in your kit. scan one to claim them and learn your guild.'}</p>
      <LinkButton to="/morse/cipher" tone="sun" icon="ticket" block data-testid="cipher-open">
        {m.ticket ? 'back to the cipher' : 'claim my slips'}
      </LinkButton>
    </Card>
  );
}

export const CipherHomeCard = CipherMorseCard;

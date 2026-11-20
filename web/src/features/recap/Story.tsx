/*
  /recap: an Instagram-story style walk through your afternoon. Tap right for next, left for back, hold to
  pause; cards advance by themselves. Every number counts up. The last card is your after hours personality
  with a 1080x1920 share image (Web Share with the file, a download everywhere else).
  StoryView is also the console's preview (`preview` renders it in a phone-sized frame, no auto-advance).
*/
import { PERSONALITIES, type Recap, STICKER_CATEGORY_INFO, stickerCategory } from '@afterhours/shared/features/recap';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { celebrate, haptics, sfx } from '../../fun';
import { Avatar, Button, ErrorState, IconButton, LoadingState, Mascot, Sticker, useToast } from '../../kit';
import { CountUp } from './CountUp';
import { PersonalityDoodle } from './Doodles';
import { recapApi, useMyRecap, useRecapStatus } from './api';
import { canvasToFile, renderShareImage, shareOrDownload } from './share';
import s from './recap.module.css';

const CARD_MS = 6500;
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();

interface CardDef {
  id: string;
  tone: string;
  body: ReactNode;
}

function Stat({ n, label, delay }: { n: number; label: string; delay?: number }) {
  return (
    <div className={s.stat}>
      <span className={s.statNum}>
        <CountUp value={n} delay={delay} />
      </span>
      <span className={s.statLabel}>{label}</span>
    </div>
  );
}

function PersonaCard({ recap }: { recap: Recap }) {
  const p = PERSONALITIES[recap.personality.id];
  const runner = recap.personality.runnerUp ? PERSONALITIES[recap.personality.runnerUp] : null;
  const avatarBox = useRef<HTMLSpanElement>(null);
  const doodle = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let dead = false;
    const t = window.setTimeout(() => {
      if (!canvas.current) return;
      void renderShareImage(canvas.current, recap, { avatar: avatarBox.current?.querySelector('svg') ?? null, doodle: doodle.current })
        .then(() => !dead && setReady(true))
        .catch(() => undefined);
    }, 120);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
  }, [recap]);

  const share = async () => {
    if (!canvas.current || busy) return;
    setBusy(true);
    try {
      const file = await canvasToFile(canvas.current);
      if (!file) throw new Error('no image');
      const how = await shareOrDownload(file);
      if (how !== 'cancelled') {
        void recapApi.shared().catch(() => undefined);
        sfx.success();
        toast(how === 'shared' ? 'shared. go flex.' : 'saved to your downloads.', { kind: 'good', title: 'your story' });
      }
    } catch {
      toast('could not make the image on this phone. a screenshot works too.', { kind: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.persona}>
      <p className={s.kicker}>your after hours personality</p>
      <div className={s.personaArt}>
        <span ref={avatarBox} className={s.personaAvatar}>
          <Avatar config={recap.attendee.avatar} size={96} />
        </span>
        <PersonalityDoodle id={p.id} size={140} svgRef={doodle} />
      </div>
      <h2 className={s.personaTitle}>{p.title}</h2>
      <p className={s.hand}>{p.line}</p>
      {runner && <p className={s.scrap}>with a dash of {runner.title}</p>}
      <div className={s.shareRow} onClick={(e) => e.stopPropagation()}>
        <canvas ref={canvas} className={s.sharePreview} data-testid="recap-share-canvas" aria-label="your shareable story image" width={1080} height={1920} />
        <Button tone="ink" size="lg" icon="share" block loading={busy} disabled={!ready} onClick={() => void share()}>
          share my story
        </Button>
      </div>
    </div>
  );
}

function buildCards(r: Recap): CardDef[] {
  const cards: CardDef[] = [];
  cards.push({
    id: 'hello',
    tone: 'ink',
    body: (
      <div className={s.hero}>
        <span className={s.heroAvatar}>
          <Avatar config={r.attendee.avatar} size={130} wobble />
        </span>
        <p className={s.kicker}>this was your</p>
        <h2 className={s.big}>after hours, {r.attendee.nickname}</h2>
        <p className={s.small}>tap to flip through. hold to pause.</p>
      </div>
    ),
  });
  cards.push({
    id: 'arrival',
    tone: 'sun',
    body: (
      <>
        <p className={s.kicker}>you walked in at</p>
        <p className={s.big}>{clock(r.arrival.at)}</p>
        <p className={s.huge}>
          #<CountUp value={r.arrival.order} />
        </p>
        <p className={s.hand}>
          through the door, out of {r.arrival.of}. {r.arrival.order <= 20 ? 'early bird energy.' : r.arrival.order > r.arrival.of * 0.8 ? 'fashionably late. we saw.' : 'right on time.'}
        </p>
      </>
    ),
  });
  if (r.sessions.count > 0) {
    cards.push({
      id: 'checkins',
      tone: 'lime',
      body: (
        <>
          <p className={s.kicker}>you checked in to</p>
          <p className={s.huge}>
            <CountUp value={r.sessions.count} />
          </p>
          <p className={s.mid}>session{r.sessions.count === 1 ? '' : 's'}</p>
          <ul className={s.tags}>
            {r.sessions.titles.slice(0, 6).map((t) => (
              <li key={t} className={s.tag}>
                {t}
              </li>
            ))}
          </ul>
        </>
      ),
    });
  }
  if (r.polls.votes > 0 || r.polls.quiz.answered > 0) {
    const q = r.polls.quiz;
    cards.push({
      id: 'quiz',
      tone: 'pink',
      body: (
        <>
          <p className={s.kicker}>polls and the quiz</p>
          <div className={s.stats}>
            <Stat n={r.polls.votes} label="votes cast" />
            <Stat n={q.correct} label={`of ${q.answered} quiz answers right`} delay={500} />
            {q.rank !== null && <Stat n={q.rank} label={`quiz rank of ${q.players}`} delay={700} />}
            <Stat n={q.points} label="quiz points" delay={900} />
          </div>
          {q.fasterThan !== null && (
            <div className={s.meter}>
              <p className={s.hand}>faster than {q.fasterThan}% of the room</p>
              <div className={s.race}>
                <motion.div className={s.raceFill} initial={{ width: 0 }} animate={{ width: `${q.fasterThan}%` }} transition={{ delay: 0.5, type: 'spring', stiffness: 60, damping: 14 }} />
              </div>
            </div>
          )}
        </>
      ),
    });
  }
  const trail = r.trails.list.find((t) => t.stamps > 0);
  if (r.trails.stamps > 0) {
    cards.push({
      id: 'trails',
      tone: 'tangerine',
      body: (
        <>
          <p className={s.kicker}>out on the trails</p>
          <p className={s.huge}>
            <CountUp value={r.trails.stamps} />
          </p>
          <p className={s.mid}>stamp{r.trails.stamps === 1 ? '' : 's'}</p>
          {trail && (
            <>
              <p className={s.scrap}>
                {trail.title}
                {trail.way ? `: you went the ${trail.way} way` : trail.finished ? ': finished!' : ''}
              </p>
              <ol className={s.path}>
                {trail.path.slice(0, 5).map((p, i) => (
                  <li key={`${p}-${i}`} className={`${s.pathStop} ${trail.way && i === 1 ? s.pathWay : ''}`}>
                    <span className={s.pathDot}>{i + 1}</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      ),
    });
  }
  if (r.morse.levels > 0 || r.morse.trailStamps > 0) {
    cards.push({
      id: 'morse',
      tone: 'sky',
      body: (
        <>
          <p className={s.kicker}>dit dit dah</p>
          <p className={s.morseStrip} aria-hidden="true">
            .-. . -.-. ..- .-. ... .
          </p>
          <div className={s.stats}>
            <Stat n={r.morse.levels} label="morse levels" />
            <Stat n={r.morse.trailStamps} label="morse objects decoded" delay={500} />
          </div>
          {r.morse.bestWpm !== null && <p className={s.big}>{Math.round(r.morse.bestWpm)} wpm best</p>}
        </>
      ),
    });
  }
  if (r.arcade.bests.length > 0 || r.arcade.levelsCleared > 0) {
    cards.push({
      id: 'arcade',
      tone: 'sun',
      body: (
        <>
          <p className={s.kicker}>at the arcade</p>
          <ul className={s.bests}>
            {r.arcade.bests.map((b) => (
              <li key={b.game} className={s.best}>
                <span>
                  <span className={s.bestGame}>{b.title}</span> <span className={s.bestLabel}>{b.label}</span>
                </span>
                <span className={s.bestRank}>#{b.rank}</span>
              </li>
            ))}
          </ul>
          {r.arcade.levelsCleared > 0 && <p className={s.hand}>and {r.arcade.levelsCleared} puzzle level{r.arcade.levelsCleared === 1 ? '' : 's'} cracked.</p>}
        </>
      ),
    });
  }
  cards.push({
    id: 'stickers',
    tone: 'paper',
    body: (
      <>
        <p className={s.kicker}>your sticker book</p>
        <p className={s.big}>
          <CountUp value={r.stickers.count} /> of {r.stickers.total}
        </p>
        <div className={s.stickers}>
          {r.stickers.recent.map((st, i) => (
            <Sticker key={st.id} def={st} size={64} tilt={i % 2 ? 8 : -7} slap />
          ))}
          {r.stickers.recent.length === 0 && <p className={s.hand}>none yet. the book is waiting.</p>}
        </div>
        {r.stickers.rarest && (
          <div className={s.rarest}>
            <Sticker def={r.stickers.rarest.sticker} size={58} tilt={-6} />
            <span className={s.hand}>
              rarest: <b>{r.stickers.rarest.sticker.title}</b>. only {r.stickers.rarest.pct}% have it. ({STICKER_CATEGORY_INFO[stickerCategory(r.stickers.rarest.sticker)].title})
            </span>
          </div>
        )}
      </>
    ),
  });
  cards.push({
    id: 'rank',
    tone: 'ink',
    body: (
      <>
        <p className={s.kicker}>final board</p>
        <p className={s.huge}>{r.standing.rank ? <>#{<CountUp value={r.standing.rank} />}</> : '-'}</p>
        <p className={s.mid}>
          <CountUp value={r.standing.total} delay={500} /> points
        </p>
        <p className={s.hand}>out of {r.standing.players} on the board. spending at the stalls never touched it.</p>
      </>
    ),
  });
  if (r.topMoment) {
    cards.push({
      id: 'moment',
      tone: 'grape',
      body: (
        <>
          <p className={s.kicker}>your biggest moment</p>
          <p className={s.huge}>
            +<CountUp value={r.topMoment.points} ding />
          </p>
          <p className={s.mid}>{r.topMoment.label}</p>
          <p className={s.scrap}>at {clock(r.topMoment.at)}</p>
        </>
      ),
    });
  }
  cards.push({ id: 'persona', tone: PERSONALITIES[r.personality.id].color, body: <PersonaCard recap={r} /> });
  return cards;
}

export function StoryView({ recap, preview = false, onClose }: { recap: Recap; preview?: boolean; onClose?: () => void }) {
  const cards = useMemo(() => buildCards(recap), [recap]);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [dir, setDir] = useState(1);
  const reduce = useReducedMotion();
  const seen = useRef(0);
  const holdAt = useRef(0);
  const last = cards.length - 1;
  const card = cards[Math.min(i, last)]!;

  const go = useCallback(
    (d: number) => {
      setDir(d);
      setI((x) => Math.max(0, Math.min(last, x + d)));
      sfx.tick();
      haptics.tick();
    },
    [last],
  );

  useEffect(() => {
    if (preview || paused || i >= last) return;
    const t = window.setTimeout(() => go(1), CARD_MS);
    return () => window.clearTimeout(t);
  }, [i, paused, preview, last, go]);

  useEffect(() => {
    if (preview) return;
    if (i + 1 > seen.current) seen.current = i + 1;
    if (i === last) {
      celebrate({ y: 0.3 });
      void recapApi.seen(cards.length).catch(() => undefined);
    }
  }, [i, last, preview, cards.length]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [go, onClose]);

  return (
    <div className={`${s.story} ${preview ? s.preview : ''}`} role="dialog" aria-label="your after hours recap">
      <div className={s.frame}>
        <div className={s.bars} aria-hidden="true">
          {cards.map((c, n) => (
            <span key={c.id} className={s.bar}>
              <motion.span
                className={s.barFill}
                initial={false}
                animate={{ scaleX: n < i ? 1 : n > i ? 0 : paused || preview || reduce ? 1 : [0, 1] }}
                transition={n === i && !paused && !preview && !reduce ? { duration: CARD_MS / 1000, ease: 'linear' } : { duration: 0.15 }}
              />
            </span>
          ))}
        </div>
        <div className={s.top}>
          <span className={s.topAvatar}>
            <Avatar config={recap.attendee.avatar} size={30} />
          </span>
          <span className={s.topWho}>
            <span className={s.topNick}>{recap.attendee.nickname}</span>
            <span className={s.topNote}>
              {i + 1} of {cards.length}
            </span>
          </span>
          {paused && <span className={s.pauseNote}>paused</span>}
          {onClose && <IconButton icon="close" label="close the recap" size="sm" onClick={onClose} />}
        </div>
        <div
          className={s.stage}
          onPointerDown={() => {
            holdAt.current = Date.now();
            setPaused(true);
          }}
          onPointerUp={(e) => {
            setPaused(false);
            if (Date.now() - holdAt.current > 350) return;
            const box = e.currentTarget.getBoundingClientRect();
            go(e.clientX - box.left < box.width * 0.3 ? -1 : 1);
          }}
          onPointerLeave={() => setPaused(false)}
        >
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            <motion.div
              key={card.id}
              className={s.cardWrap}
              custom={dir}
              initial={reduce ? { opacity: 0 } : { opacity: 0, rotateY: dir * 35, x: dir * 80, rotate: dir * 3 }}
              animate={{ opacity: 1, rotateY: 0, x: 0, rotate: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, rotateY: -dir * 35, x: -dir * 80 }}
              transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            >
              <section className={`${s.card} ${s[`t-${card.tone}`] ?? ''}`} data-card={card.id} aria-roledescription="story card">
                {card.body}
              </section>
            </motion.div>
          </AnimatePresence>
        </div>
        <p className={s.navHint}>{i < last ? 'tap for next, left edge to go back' : 'that was your afternoon. thank you for coming.'}</p>
      </div>
    </div>
  );
}

/** The locked page: shown before the organisers open recaps. */
function Locked({ closing }: { closing: boolean }) {
  return (
    <div className={s.locked}>
      <Mascot size={110} mood="sleepy" />
      <h1 className={s.lockedTitle}>your recap is cooking</h1>
      <p className={s.hand}>{closing ? 'the final board is being revealed. watch the big screen, your story opens right after.' : 'it unlocks after the closing reveal. keep playing, every point ends up in it.'}</p>
    </div>
  );
}

export function RecapPage() {
  const status = useRecapStatus();
  const open = status.data?.open ?? false;
  const me = useMyRecap(open);
  const nav = useNavigate();
  const close = useCallback(() => nav('/', { replace: true }), [nav]);
  if (status.isPending) return <LoadingState label="checking..." />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (!open) return <Locked closing={status.data.closing} />;
  if (me.isPending) return <LoadingState label="stitching your afternoon together..." />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  return <StoryView recap={me.data} onClose={close} />;
}

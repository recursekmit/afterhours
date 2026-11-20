/*
  Home. Top to bottom: greeting + tappable you, points ticket, the slot where
  every feature's home card renders (registry order), sticker book strip,
  install nudge, mute switch.
*/
import type { MeResponse } from '@afterhours/shared';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { homeCards, useHiddenFeatures } from '../../core/featureHost';
import { InstallCard } from '../../core/pwa/install';
import { useMyPoints, usePresence, useStickerBook } from '../../core/queries';
import { SignOutButton } from './SignOut';
import { haptics, sfx, useMuted } from '../../fun';
import { Avatar, Card, Doodle, EmptyState, IconButton, NumberTicker, Sheet, Sticker, Torn } from '../../kit';
import { MadeByRecurse, RecurseLogo } from '../../kit/Brand';
import s from './attendee.module.css';

const HELLOS = ['hey,', 'oh hi,', 'sup,', 'yo,', 'hello,'];
const BOOPS = ['boop.', 'ow. rude.', 'you found my nose', 'again again', 'i was napping', 'hehe', 'ok that was funny'];

function Greeting({ me }: { me: MeResponse }) {
  const hello = useMemo(() => HELLOS[Math.floor(Math.random() * HELLOS.length)] ?? 'hey,', []);
  const [scope, animate] = useAnimate<HTMLButtonElement>();
  const reduce = useReducedMotion();
  const [line, setLine] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [muted, setMuted] = useMuted();
  const nick = me.attendee.nickname ?? 'you';
  const boop = () => {
    sfx.pop();
    haptics.tap();
    if (!reduce && scope.current) void animate(scope.current, { scale: [1, 1.2, 0.88, 1.05, 1], rotate: [0, -8, 6, -2, 0] }, { duration: 0.5 });
    setLine(BOOPS[Math.floor(Math.random() * BOOPS.length)] ?? 'boop.');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLine(null), 1300);
  };
  return (
    <Torn tone="sun" className={s.greet}>
      <div className={s.greetRow}>
        <div>
          <span className={s.homeMark}>
            <RecurseLogo height={20} />
          </span>
          <p className={s.hello}>{hello}</p>
          <h1 className={s.nick}>{nick}</h1>
        </div>
        <div className={s.meWrap}>
          <AnimatePresence>
            {line && (
              <motion.span className={s.bubble} initial={{ opacity: 0, scale: 0.6, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.7 }} transition={{ type: 'spring', stiffness: 520, damping: 22 }}>
                {line}
              </motion.span>
            )}
          </AnimatePresence>
          <button ref={scope} type="button" className={s.meBtn} onClick={boop} aria-label="boop your avatar">
            <Avatar config={me.attendee.avatar} size={104} wobble />
          </button>
        </div>
      </div>
      <IconButton
        icon={muted ? 'mute' : 'sound'}
        label={muted ? 'turn sound on' : 'mute sound'}
        size="sm"
        tone={muted ? 'pink' : 'paper'}
        className={s.muteBtn}
        quiet
        aria-pressed={muted}
        onClick={() => {
          const next = !muted;
          setMuted(next);
          if (!next) {
            // sound just turned on: say so out loud
            window.setTimeout(() => sfx.success(), 40);
          }
        }}
      />
    </Torn>
  );
}

function PointsTicket() {
  const pts = useMyPoints();
  const [open, setOpen] = useState(false);
  const total = pts.data?.total ?? 0;
  const rank = pts.data?.rank;
  return (
    <>
      <Card tone="ink" tilt={-1.2} press lift className={s.ticket} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)} aria-label="your points, tap for history">
        <span className={`${s.notch} ${s.notchL}`} aria-hidden="true" />
        <span className={`${s.notch} ${s.notchR}`} aria-hidden="true" />
        <div className={s.ticketMain}>
          <p className={s.ticketLabel}>your points</p>
          <NumberTicker value={total} className={s.ticketNum} />
        </div>
        <div className={s.ticketRank}>
          {rank ? (
            <>
              <span className={s.rankStamp}>#{rank}</span>
              <span className={s.rankNote}>on the board</span>
            </>
          ) : (
            <span className={s.rankNote}>get on the board</span>
          )}
        </div>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="where they came from">
        {pts.data && pts.data.history.length > 0 ? (
          <ul className={s.history}>
            {pts.data.history.map((h) => (
              <li key={`${h.source}:${h.ref}`}>
                <span className={s.histPts}>+{h.points}</span>
                <span>{h.label ?? h.source}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="nothing yet" hint="vote, hunt, play. points show up here." />
        )}
      </Sheet>
    </>
  );
}

function StickerStrip() {
  const book = useStickerBook();
  const cat = book.data?.catalogue ?? [];
  const got = book.data?.unlocked ?? {};
  const count = cat.filter((c) => got[c.id]).length;
  const shown = [...cat].sort((a, b) => Number(Boolean(got[b.id])) - Number(Boolean(got[a.id])) || a.order - b.order).slice(0, 5);
  return (
    <Link to="/stickers" className={s.stripLink} aria-label="open sticker book">
      <Card tone="paper" tilt={0.9} press tape="right" tapeColor="lime">
        <div className={s.stripHead}>
          <h3 className={s.stripTitle}>sticker book</h3>
          <span className={s.stripCount}>
            <NumberTicker value={count} />/{cat.length}
          </span>
        </div>
        <div className={s.stripRow}>
          {shown.map((d, i) => (
            <Sticker key={d.id} def={d} size={58} tilt={(i % 2 ? 1 : -1) * (4 + i * 2)} locked={!got[d.id]} />
          ))}
          {shown.length === 0 && <p className={s.handNote}>fresh book. go earn some.</p>}
        </div>
      </Card>
    </Link>
  );
}

function PresenceNote() {
  const p = usePresence();
  if (!p.data || p.data.here < 2) return null;
  return (
    <p className={s.presence}>
      <Doodle name="users" size={22} fill="var(--lime)" />
      <span>
        <b>
          <NumberTicker value={p.data.here} />
        </b>{' '}
        people here so far
      </span>
    </p>
  );
}

export function Home({ me }: { me: MeResponse }) {
  const hidden = useHiddenFeatures();
  const cards = homeCards.filter((c) => !hidden.has(c.feature));
  return (
    <div className={s.home}>
      <Greeting me={me} />
      <div className={s.homeBody}>
        {/* order < 10: the cards that matter most right now (now and next) sit above your points */}
        <section className={s.slot} data-slot="home-top" aria-label="now">
          {cards
            .filter((c) => c.order < 10)
            .map((c) => (
              <c.Card key={c.feature} />
            ))}
        </section>
        <PointsTicket />
        <PresenceNote />
        <section className={s.slot} data-slot="home-cards" aria-label="happening">
          {cards.filter((c) => c.order >= 10).map((c) => (
            <c.Card key={c.feature} />
          ))}
        </section>
        <StickerStrip />
        <InstallCard />
        <SignOutButton me={me} />
        <MadeByRecurse />
      </div>
    </div>
  );
}

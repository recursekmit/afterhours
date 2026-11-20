/*
  Sticker book: a little zine you flip through, one page per kind of sticker (showing up, polls, trails,
  morse, arcade, secret). Each page says how complete it is. Earned stickers are die-cut and peel onto
  the page, with "only N% have this" on the rare ones; locked ones are ink silhouettes with a cheeky hint.
  Tap a sticker to look closer, and slap it as much as you like (the book keeps count, and someone noticed).
*/
import type { StickerDef } from '@afterhours/shared';
import { STICKER_CATEGORIES, STICKER_CATEGORY_INFO, type StickerCategory, rarityPct, stickerCategory } from '@afterhours/shared/features/recap';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStickerBook } from '../../core/queries';
import { useTrailVisibility } from '../../features/hunt/useHunt';
import { recapApi, rk } from '../../features/recap/api';
import { haptics, sfx } from '../../fun';
import { Doodle, ErrorState, LoadingState, Meter, NumberTicker, Scribble, Sheet, Sticker } from '../../kit';
import s from './stickerbook.module.css';

const CHEEKY = ['psst:', 'rumour has it:', 'allegedly:', 'no spoilers, but:', 'a little bird says:', 'between us:'];

/** Slaps go to the server in small batches; the sticker for slapping lives on the server. */
function useSlaps() {
  const pending = useRef(0);
  useEffect(() => {
    const flush = () => {
      const n = pending.current;
      if (n <= 0) return;
      pending.current = 0;
      void recapApi.slap(n).catch(() => undefined);
    };
    const iv = window.setInterval(flush, 1500);
    return () => {
      window.clearInterval(iv);
      flush();
    };
  }, []);
  return () => {
    pending.current += 1;
  };
}

function Detail({ def, got, at, pct, onSlap }: { def: StickerDef; got: boolean; at: number | null; pct: number | null; onSlap: () => void }) {
  const [scope, animate] = useAnimate<HTMLButtonElement>();
  const reduce = useReducedMotion();
  const [slaps, setSlaps] = useState(0);
  const slap = () => {
    if (!got) return;
    setSlaps((n) => n + 1);
    onSlap();
    sfx.pop();
    haptics.tap();
    if (!reduce && scope.current) void animate(scope.current, { scale: [1, 0.86, 1.08, 1], rotate: [-6, -12, 2, -6] }, { duration: 0.35 });
  };
  return (
    <div className={s.detail}>
      <button ref={scope} type="button" className={s.slapTarget} onClick={slap} aria-label={got ? `slap ${def.title}` : def.title} disabled={!got}>
        <motion.span className={s.peel} initial={reduce || !got ? false : { rotateX: 70, rotateZ: -12, y: -30, opacity: 0 }} animate={{ rotateX: 0, rotateZ: 0, y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 15 }}>
          <Sticker def={def} size={170} tilt={-6} locked={!got} />
        </motion.span>
      </button>
      {got ? (
        <>
          {pct !== null && <p className={s.rare}>{pct <= 25 ? `only ${pct}% have this` : `${pct}% of the room have this`}</p>}
          <p className={s.hint}>{def.hint}</p>
          {at && <p className={s.fine}>stuck in at {new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</p>}
          <p className={s.fine}>{slaps === 0 ? 'tap it to slap it. go on.' : `slapped ${slaps} time${slaps === 1 ? '' : 's'}`}</p>
        </>
      ) : (
        <p className={s.hint}>{def.hint}</p>
      )}
    </div>
  );
}

export function StickerBook() {
  const book = useStickerBook();
  const rarity = useQuery({ queryKey: rk.rarity, queryFn: () => recapApi.rarity(), staleTime: 30_000, retry: 1 });
  const reduce = useReducedMotion();
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState(1);
  const [open, setOpen] = useState<StickerDef | null>(null);
  const slap = useSlaps();

  // stickers of an event hidden from players (treasure hunt, morse challenge) are not in the book yet
  const vis = useTrailVisibility();
  const pages = useMemo(() => {
    const hidden = (id: string) => (!vis.hunt && id.startsWith('hunt-')) || (!vis.morse && id.startsWith('trail-morse-'));
    const cat = (book.data?.catalogue ?? []).filter((d) => !hidden(d.id));
    return STICKER_CATEGORIES.map((c) => ({ id: c, defs: cat.filter((d) => stickerCategory(d) === c).sort((a, b) => a.order - b.order) })).filter((p) => p.defs.length > 0);
  }, [book.data, vis.hunt, vis.morse]);

  if (book.isPending) return <LoadingState label="finding your stickers..." />;
  if (book.isError) return <ErrorState error={book.error} onRetry={() => void book.refetch()} />;
  const { catalogue, unlocked } = book.data;
  const count = catalogue.filter((d) => unlocked[d.id]).length;
  const cur = pages[Math.min(page, pages.length - 1)];
  const flip = (to: number) => {
    if (to < 0 || to >= pages.length || to === page) return;
    setDir(to > page ? 1 : -1);
    setPage(to);
    sfx.whoosh();
    haptics.tick();
  };
  const pctOf = (id: string) => (rarity.data && rarity.data.attendees > 0 ? rarityPct(rarity.data, id) : null);

  return (
    <div className={s.book}>
      <header className={s.head}>
        <h1 className={s.title}>sticker book</h1>
        <Scribble color="var(--lime)" style={{ width: 150 }} />
        <p className={s.note}>
          <NumberTicker value={count} /> of {catalogue.length} stuck in. flip the pages, the silhouettes drop hints.
        </p>
      </header>

      <nav className={s.tabs} aria-label="pages">
        {pages.map((p, i) => {
          const info = STICKER_CATEGORY_INFO[p.id as StickerCategory];
          const got = p.defs.filter((d) => unlocked[d.id]).length;
          const done = got === p.defs.length;
          return (
            <button key={p.id} type="button" className={`${s.tab} ${i === page ? s.tabOn : ''}`} aria-current={i === page ? 'page' : undefined} onClick={() => flip(i)}>
              <Doodle name={info.glyph} size={18} />
              {info.title}
              <span className={s.tabCount}>{done ? <Doodle name="check" size={14} /> : `${got}/${p.defs.length}`}</span>
            </button>
          );
        })}
      </nav>

      {cur && (
        <div className={s.spine}>
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.section
              key={cur.id}
              className={s.page}
              data-ground="parchment"
              style={{ transformOrigin: dir > 0 ? 'left center' : 'right center' }}
              initial={reduce ? { opacity: 0 } : { rotateY: dir * 70, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { rotateY: -dir * 70, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 24 }}
              drag={reduce ? false : 'x'}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.25}
              onDragEnd={(_, info) => {
                if (info.offset.x < -70) flip(page + 1);
                else if (info.offset.x > 70) flip(page - 1);
              }}
              aria-label={`${STICKER_CATEGORY_INFO[cur.id as StickerCategory].title} page`}
            >
              {(() => {
                const info = STICKER_CATEGORY_INFO[cur.id as StickerCategory];
                const got = cur.defs.filter((d) => unlocked[d.id]).length;
                return (
                  <div className={s.pageHead}>
                    <span className={s.pageGlyph} style={{ background: `var(--${info.color})` }}>
                      <Doodle name={info.glyph} size={30} />
                    </span>
                    <div className={s.pageTitles}>
                      <h2 className={s.pageTitle}>{info.title}</h2>
                      <p className={s.fine}>{info.blurb}</p>
                    </div>
                    <div className={s.pageMeter}>
                      <Meter value={got / cur.defs.length} tone={info.color === 'paper' || info.color === 'ink' ? 'lime' : info.color} label={`${info.title}: ${got} of ${cur.defs.length}`} />
                      <span className={s.fine}>{got === cur.defs.length ? 'page complete!' : `${got} of ${cur.defs.length}`}</span>
                    </div>
                  </div>
                );
              })()}
              <div className={s.grid}>
                {cur.defs.map((d, i) => {
                  const got = Boolean(unlocked[d.id]);
                  const tilt = ((i * 37) % 17) - 8;
                  const pct = got ? pctOf(d.id) : null;
                  return (
                    <button key={d.id} type="button" className={s.slot} onClick={() => setOpen(d)} aria-label={got ? d.title : `locked: ${d.hint}`}>
                      <motion.span
                        className={got ? s.dieCut : s.silhouette}
                        initial={reduce || !got ? false : { rotateX: 60, y: -14, opacity: 0 }}
                        animate={{ rotateX: 0, y: 0, opacity: 1 }}
                        transition={{ delay: 0.08 * i, type: 'spring', stiffness: 260, damping: 16 }}
                      >
                        <Sticker def={d} size={84} tilt={got ? tilt : tilt / 2} locked={!got} />
                      </motion.span>
                      {got ? <span className={s.slotTitle}>{d.title}</span> : <span className={s.slotHint}>{`${CHEEKY[i % CHEEKY.length]} ${d.hint}`}</span>}
                      {pct !== null && pct <= 25 && <span className={s.badge}>only {pct}%</span>}
                    </button>
                  );
                })}
              </div>
              <div className={s.pager}>
                <button type="button" className={s.turn} onClick={() => flip(page - 1)} disabled={page === 0} aria-label="previous page">
                  <Doodle name="arrow" size={22} style={{ transform: 'scaleX(-1)' }} />
                </button>
                <span className={s.fine}>
                  page {page + 1} of {pages.length}
                </span>
                <button type="button" className={s.turn} onClick={() => flip(page + 1)} disabled={page >= pages.length - 1} aria-label="next page">
                  <Doodle name="arrow" size={22} />
                </button>
              </div>
            </motion.section>
          </AnimatePresence>
        </div>
      )}

      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open && unlocked[open.id] ? open.title : 'not yet'}>
        {open && <Detail def={open} got={Boolean(unlocked[open.id])} at={(unlocked[open.id] as number | undefined) ?? null} pct={pctOf(open.id)} onSlap={slap} />}
      </Sheet>
    </div>
  );
}

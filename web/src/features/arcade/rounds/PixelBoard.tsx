/*
  Rebuild the Image board.
  - Tap a pixel to flip it. Changed pixels carry a corner diamond, so you can see what you touched.
  - Every row clue (right) and column clue (below) says odd or even; it ticks when your grid matches.
    Marked groups (yellow frame, numbered tag) have their own clue.
  - Hard levels cap taps, undos included: think before you tap. Out of taps, Check is the only move,
    and a wrong check clears the board.
  - Win: the finished picture drops into place, pixel by pixel.
*/
import { applyFlips, type Cell, cellKey, checkClues, netFlips } from '@afterhours/shared/features/arcade-pixels';
import type { TryResponse } from '@afterhours/shared/features/arcade-rounds';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { haptics, sfx } from '../../../fun';
import { Button } from '../../../kit';
import type { BoardProps } from './Play';
import s from './rounds.module.css';

const colName = (c: number) => String.fromCharCode(65 + c);

export function PixelBoard({ body, attempt, onTry, busy, resetKey, onWin }: BoardProps<'pixels'>) {
  const p = body.puzzle;
  const reduce = useReducedMotion();
  const [taps, setTaps] = useState<Cell[]>([]);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [art, setArt] = useState<{ art: string[]; name: string } | null>(null);
  useEffect(() => {
    setTaps([]);
    setVerdict(null);
    setArt(null);
  }, [resetKey]);

  const flips = netFlips(taps);
  const flipped = new Set(flips.map(cellKey));
  const grid = applyFlips(p.start, flips);
  const check = checkClues(p, grid);
  const groupOf = new Map<string, number>();
  p.groups.forEach((g, gi) => g.cells.forEach((c) => groupOf.set(cellKey(c), gi)));
  const tagAt = new Map(p.groups.map((g, gi) => [cellKey(g.cells[0]!), gi]));
  const hint = attempt.hint?.game === 'pixels' ? cellKey(attempt.hint.cell) : null;
  const won = attempt.status === 'won';
  const outOfTaps = p.tapBudget !== null && taps.length >= p.tapBudget;
  const tooMany = flips.length > p.maxFlips;

  const tap = (r: number, c: number) => {
    if (busy || won || art) return;
    if (outOfTaps) {
      sfx.fail();
      haptics.fail();
      setVerdict('out of taps. check it, or eat the miss.');
      return;
    }
    setTaps((t) => [...t, [r, c]]);
    setVerdict(null);
    sfx.tap();
    haptics.tick();
  };

  const submit = async () => {
    const r: TryResponse | null = await onTry({ game: 'pixels', taps }).catch(() => null);
    if (!r || r.outcome.game !== 'pixels') return;
    if (r.ok && r.reveal) {
      setArt(r.reveal);
      sfx.success();
      window.setTimeout(() => onWin(r), reduce ? 200 : 900);
      return;
    }
    sfx.fail();
    haptics.fail();
    setVerdict(r.outcome.result.reason);
    // A wrong check spends the board: start again from the damaged picture.
    if (p.tapBudget !== null) setTaps([]);
  };

  const n = p.size;
  const cols = `repeat(${n}, minmax(0, 1fr))`;

  return (
    <div className={`${s.board} ${s.pixBoard}`}>
      {art ? (
        <div className={s.under}>
          <div className={s.reveal} style={{ gridTemplateColumns: cols }} role="img" aria-label={`the finished picture: ${art.name}`}>
            {art.art.flatMap((row, r) =>
              [...row].map((ch, c) => (
                <motion.span
                  key={`${r},${c}`}
                  className={`${s.revealCell} ${ch === '1' ? s.revealOn : ''}`}
                  initial={reduce ? false : { y: -60 - r * 12, opacity: 0, rotate: (c - n / 2) * 8 }}
                  animate={{ y: 0, opacity: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 22, delay: reduce ? 0 : (r * n + c) * 0.018 }}
                />
              )),
            )}
          </div>
          <p className={s.winLabel} style={{ textAlign: 'center' }}>
            it's {art.name}!
          </p>
        </div>
      ) : (
        <>
          <div className={s.pixWrap}>
            <div className={s.pix} style={{ gridTemplateColumns: cols }} role="grid" aria-label={`${n} by ${n} picture`}>
              {grid.map((row, r) =>
                row.map((on, c) => {
                  const k = `${r},${c}`;
                  const g = groupOf.get(k);
                  const tag = tagAt.get(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      role="gridcell"
                      aria-pressed={on}
                      aria-label={`${colName(c)}${r + 1}, ${on ? 'lit' : 'dark'}${flipped.has(k) ? ', changed' : ''}${g !== undefined ? `, in group ${g + 1}` : ''}`}
                      className={`${s.cell} ${on ? s.cellOn : ''} ${g !== undefined ? s.cellGroup : ''} ${flipped.has(k) ? s.cellFlipped : ''} ${hint === k ? s.cellHint : ''}`}
                      onClick={() => tap(r, c)}
                      disabled={won}
                    >
                      {tag !== undefined && <span className={s.cellGroupTag}>{tag + 1}</span>}
                    </button>
                  );
                }),
              )}
            </div>
            <div className={s.pix} style={{ gridTemplateRows: `repeat(${n}, minmax(0, 1fr))` }} aria-label="row clues">
              {p.rows.map((want, r) => (
                <span key={r} className={`${s.clue} ${check.rows[r] ? s.clueOk : ''}`} title={`row ${r + 1}: ${want} lit`}>
                  {want}
                  {check.rows[r] && <span className={s.clueMark}>✓</span>}
                </span>
              ))}
            </div>
            <div className={s.pix} style={{ gridTemplateColumns: cols }} aria-label="column clues">
              {p.cols.map((want, c) => (
                <span key={c} className={`${s.clue} ${s.clueCol} ${check.cols[c] ? s.clueOk : ''}`} title={`column ${colName(c)}: ${want} lit`}>
                  {want}
                  {check.cols[c] && <span className={s.clueMark}>✓</span>}
                </span>
              ))}
            </div>
          </div>
          <div className={s.under}>
            {p.groups.length > 0 && (
              <div className={s.groupLegend}>
                {p.groups.map((g, gi) => (
                  <span key={gi} className={`${s.chip} ${check.groups[gi] ? s.chipLime : s.chipSun}`}>
                    group {gi + 1} ({g.cells.length} framed cells): {g.parity} {check.groups[gi] ? '✓' : ''}
                  </span>
                ))}
              </div>
            )}
            <div className={s.statusRow}>
              <span className={`${s.chip} ${tooMany ? s.chipPink : ''}`}>
                changed {flips.length} of {p.maxFlips}
              </span>
              {p.tapBudget !== null && (
                <span className={`${s.chip} ${outOfTaps ? s.chipPink : s.chipInk}`}>
                  taps {taps.length} of {p.tapBudget}
                </span>
              )}
              {check.all && !tooMany && <span className={`${s.chip} ${s.chipLime}`}>✓ every clue ticks</span>}
            </div>
            {hint && <p className={s.hintBox}>house hint: the dashed pixel is one of the broken ones.</p>}
            {verdict && (
              <p className={`${s.outcome} ${s.outcomeBad}`} aria-live="polite">
                <span className={s.mark}>✕</span>
                <span>{verdict}</span>
              </p>
            )}
            <p className={s.legend}>
              {p.maxFlips === 1 ? 'one pixel is wrong.' : `${p.maxFlips} pixels are wrong.`} odd / even = how many lit pixels that row, column or framed group should have.
              {p.tapBudget !== null ? ' every tap counts here, undos too.' : ''}
            </p>
            <Button tone="lime" size="lg" icon="check" block loading={busy} disabled={won || taps.length === 0} onClick={() => void submit()}>
              check the picture
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

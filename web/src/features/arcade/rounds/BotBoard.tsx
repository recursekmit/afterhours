/*
  Patch the Bot board.
  - The program is a stack of numbered cards. Tap one, pick a new command: that's your one patch.
    Picking a card's original command again undoes it; patching another card moves the patch.
  - Run tests: the server runs the patched program on every map. We replay each run: the card being
    executed lights up and the bot hops tile to tile, so you see exactly which card sent it into a wall.
  - Map tabs show pass / fail with a mark and a word, not just a colour.
*/
import { BOT_COMMAND_LABEL, BOT_COMMANDS, type BotCommand, type BotMap, type BotPatch, type BotStep, cellName } from '@afterhours/shared/features/arcade-bot';
import type { TryResponse } from '@afterhours/shared/features/arcade-rounds';
import { motion, useAnimate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { haptics, sfx } from '../../../fun';
import { Button, Doodle } from '../../../kit';
import { ui } from '../../common/ui';
import type { BoardProps } from './Play';
import s from './rounds.module.css';

const STEP_MS = 340;
type Run = Extract<TryResponse['outcome'], { game: 'patch' }>['result']['runs'][number];
const ROT = { n: 0, e: 90, s: 180, w: 270 } as const;

export function CmdIcon({ cmd }: { cmd: BotCommand }) {
  const wall = cmd === 'wallL' || cmd === 'wallR';
  const turn = cmd === 'left' || cmd === 'wallL' ? 'l' : cmd === 'right' || cmd === 'wallR' ? 'r' : null;
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      {wall && <rect x="3" y="2" width="18" height="5" fill="var(--ink)" stroke="none" rx="1" />}
      {!turn && <path d="M12 21V6M6.5 11.5L12 6l5.5 5.5" />}
      {turn === 'l' && <path d="M17 21v-6a5 5 0 0 0-5-5H6M10 6l-4 4 4 4" />}
      {turn === 'r' && <path d="M7 21v-6a5 5 0 0 1 5-5h6M14 6l4 4-4 4" />}
    </svg>
  );
}

function MapView({ map, at, trail, crash }: { map: BotMap; at: { x: number; y: number; dir: BotStep['dir'] }; trail: Set<string>; crash: boolean }) {
  const reduce = useReducedMotion();
  const w = map.rows[0]!.length;
  const cols = `22px repeat(${w}, minmax(0, 1fr))`;
  return (
    <div role="img" aria-label={`map ${map.name}, bot at ${cellName(at.x, at.y)} facing ${{ n: 'up', e: 'right', s: 'down', w: 'left' }[at.dir]}`}>
      <div className={s.gridLabels} style={{ gridTemplateColumns: cols }}>
        <span />
        {Array.from({ length: w }, (_, x) => (
          <span key={x}>{String.fromCharCode(65 + x)}</span>
        ))}
      </div>
      <div className={s.grid} style={{ gridTemplateColumns: cols }}>
        {map.rows.map((row, y) => [
          <span key={`r${y}`} className={s.gridLabels} style={{ display: 'grid', placeItems: 'center' }}>
            {y + 1}
          </span>,
          ...[...row].map((ch, x) => {
            const here = at.x === x && at.y === y;
            const cls = ch === '#' ? s.tileWall : ch === 'G' ? s.tileGoal : trail.has(`${x},${y}`) ? s.tileTrail : '';
            return (
              <div key={`${x},${y}`} className={`${s.tile} ${cls} ${here && crash ? s.tileCrash : ''}`}>
                {ch === 'G' && !here && <Doodle name="flag" size={22} />}
                {here && (
                  <motion.div layoutId={`bot-${map.name}`} className={s.bot} animate={{ rotate: ROT[at.dir] }} transition={{ duration: reduce ? 0 : 0.22 }}>
                    <span className={s.botEye} />
                  </motion.div>
                )}
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}

export function BotBoard({ body, attempt, onTry, busy, resetKey, onWin }: BoardProps<'patch'>) {
  const reduce = useReducedMotion();
  const [patch, setPatch] = useState<BotPatch | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState(0);
  /** The last Run tests answer, replayed map by map. */
  const [result, setResult] = useState<Run[] | null>(null);
  /** Playback cursor: which map and which step is on screen. */
  const [cursor, setCursor] = useState<{ map: number; i: number } | null>(null);
  /** Maps whose pass/fail is already revealed. */
  const [revealed, setRevealed] = useState(0);
  const timers = useRef<number[]>([]);
  const [shake, animate] = useAnimate<HTMLDivElement>();

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => {
    clearTimers();
    setPatch(null);
    setResult(null);
    setCursor(null);
    setRevealed(0);
    setTab(0);
  }, [resetKey]);
  useEffect(() => clearTimers, []);

  const won = attempt.status === 'won';
  const hintLine = attempt.hint?.game === 'patch' ? attempt.hint.line : null;
  const program = body.program.map((c, i) => (patch?.line === i ? patch.cmd : c));
  const playing = cursor !== null;
  const locked = busy || playing || won;

  const forget = () => {
    setResult(null);
    setRevealed(0);
  };
  const pick = (line: number, cmd: BotCommand) => {
    setPatch(cmd === body.program[line] ? null : { line, cmd });
    setOpen(null);
    forget();
    sfx.pop();
    haptics.tap();
  };

  const runTests = async () => {
    if (!patch) return;
    clearTimers();
    const r = await onTry({ game: 'patch', patch }).catch(() => null);
    if (!r || r.outcome.game !== 'patch') return;
    const runs = r.outcome.result.runs;
    setResult(runs);
    setRevealed(0);
    const step = reduce ? STEP_MS / 2 : STEP_MS;
    let t = 0;
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    runs.forEach((run, m) => {
      at(t, () => (setTab(m), setCursor({ map: m, i: -1 })));
      t += 350;
      run.steps.forEach((st, i) => {
        at(t, () => {
          setCursor({ map: m, i });
          if (st.did === 'crash') {
            sfx.fail();
            haptics.fail();
            if (!reduce && shake.current) void animate(shake.current, { x: [0, -8, 8, -4, 0] }, { duration: 0.35 });
          } else if (st.did === 'goal') sfx.success();
          else sfx.tick();
        });
        t += step;
      });
      at(t, () => setRevealed(m + 1));
      t += 550;
    });
    at(t, () => {
      setCursor(null);
      if (r.ok) onWin(r);
      else {
        // Land on the first failing map so the reason is right there.
        const bad = runs.findIndex((x) => !x.ok);
        if (bad >= 0) setTab(bad);
      }
    });
  };

  // What the visible map shows.
  const map = body.maps[tab]!;
  const run = result?.[tab] ?? null;
  const upto = cursor && cursor.map === tab ? cursor.i : run && tab < revealed ? run.steps.length - 1 : -1;
  const steps = run && upto >= 0 ? run.steps.slice(0, upto + 1) : [];
  const last = steps.at(-1);
  const at = last ? { x: last.x, y: last.y, dir: last.dir } : map.start;
  const trail = new Set([`${map.start.x},${map.start.y}`, ...steps.map((st) => `${st.x},${st.y}`)]);
  const runningPc = cursor && cursor.map === tab && last ? last.pc : null;
  const failPc = !playing && run && tab < revealed && !run.ok ? run.failPc : null;

  return (
    <div className={s.board}>
      <div className={s.mapTabs} role="tablist" aria-label="test maps">
        {body.maps.map((m, i) => {
          const r = result && i < revealed ? result[i]! : null;
          return (
            <button
              key={m.name}
              type="button"
              role="tab"
              aria-selected={tab === i}
              className={`${s.mapTab} ${tab === i ? s.mapTabOn : ''}`}
              style={r ? { background: r.ok ? 'var(--lime)' : 'var(--pink)' } : undefined}
              onClick={() => !playing && setTab(i)}
            >
              <span className={s.mark}>{r ? (r.ok ? '✓' : '✕') : i + 1}</span>
              {m.name}
              {r && <span>{r.ok ? 'pass' : 'fail'}</span>}
            </button>
          );
        })}
      </div>
      <div ref={shake} className={s.under}>
        <MapView map={map} at={at} trail={trail} crash={last?.did === 'crash'} />
        <div className={s.battery}>
          <Doodle name="bolt" size={20} />
          battery {Math.max(0, body.battery - steps.length)}/{body.battery}
          {last?.did === 'goal' && <span className={`${s.chip} ${s.chipLime}`}>✓ goal</span>}
        </div>
        {run && tab < revealed && !playing && (
          <p className={`${s.outcome} ${run.ok ? s.outcomeGood : s.outcomeBad}`} aria-live="polite">
            <span className={s.mark}>{run.ok ? '✓' : '✕'}</span>
            <span>{run.reason}</span>
          </p>
        )}
      </div>

      <div className={s.under}>
        <p className={s.say}>the bot runs the cards top to bottom, then loops. change exactly one card.</p>
        <ol className={s.program} aria-label="program">
          {program.map((cmd, i) => {
            const patched = patch?.line === i;
            return (
              <li key={i} className={ui.stack} style={{ gap: 6 }}>
                <button
                  type="button"
                  className={`${s.card} ${patched ? s.cardPatched : ''} ${runningPc === i ? s.cardRunning : ''} ${failPc === i ? s.cardFail : ''} ${hintLine === i ? s.cardHint : ''}`}
                  disabled={locked}
                  aria-expanded={open === i}
                  aria-label={`card ${i + 1}: ${BOT_COMMAND_LABEL[cmd]}${patched ? `, patched from ${BOT_COMMAND_LABEL[body.program[i]!]}` : ''}`}
                  onClick={() => setOpen(open === i ? null : i)}
                >
                  <span className={s.cardNo}>{i + 1}</span>
                  <CmdIcon cmd={cmd} />
                  <span>{BOT_COMMAND_LABEL[cmd]}</span>
                  {patched ? <span className={s.cardWas}>{BOT_COMMAND_LABEL[body.program[i]!]}</span> : hintLine === i ? <span className={s.cardWas}>hint: this one</span> : <span />}
                </button>
                {open === i && (
                  <motion.div className={s.picker} initial={reduce ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} role="group" aria-label={`new command for card ${i + 1}`}>
                    {BOT_COMMANDS.map((c) => (
                      <button key={c} type="button" className={`${s.pickBtn} ${c === cmd ? s.pickBtnOn : ''}`} onClick={() => pick(i, c)}>
                        <CmdIcon cmd={c} />
                        {BOT_COMMAND_LABEL[c]}
                        {c === body.program[i] && patched ? ' (undo)' : ''}
                      </button>
                    ))}
                  </motion.div>
                )}
              </li>
            );
          })}
        </ol>
        <p className={s.legend}>wall? cards only turn when a wall is right in front. off the map counts as wall.</p>
        <div className={s.actions}>
          <Button tone="lime" size="lg" icon="play" block loading={busy} disabled={!patch || locked} onClick={() => void runTests()}>
            {patch ? 'run tests' : 'change a card'}
          </Button>
          <Button tone="paper" icon="undo" disabled={!patch || locked} onClick={() => (setPatch(null), forget())} aria-label="undo patch">
            undo
          </Button>
        </div>
      </div>
    </div>
  );
}

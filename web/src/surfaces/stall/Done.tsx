/* The success screen: big enough to read at arm's length, gone by itself in a few seconds. */
import type { CommitResponse } from '@afterhours/shared/features/stalls';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect } from 'react';
import { confetti, haptics, sfx } from '../../fun';
import { Button, Doodle } from '../../kit';
import { linesText } from '../../features/stalls/parts';
import s from './stall.module.css';

export function Done({ result, onNext }: { result: CommitResponse; onNext: () => void }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    sfx.success();
    haptics.success();
    confetti({ count: 36, y: 0.35, spread: 60 });
    const t = window.setTimeout(onNext, 4200);
    return () => window.clearTimeout(t);
  }, [onNext]);
  const free = result.freeUsed;
  const headline = free > 0 && result.lines.every((l) => l.freeQty === l.qty) ? `${free} free mocktail${free > 1 ? 's' : ''}, ${result.freeLeft} left` : linesText(result.lines);
  return (
    <main className={s.done} onClick={onNext}>
      <motion.div className={s.doneCard} initial={reduce ? false : { scale: 0.7, rotate: -4 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 16 }}>
        <span className={s.doneTick}>
          <Doodle name="check" size={96} stroke="currentColor" />
        </span>
        <h1 className={s.doneHead}>{headline}</h1>
        <p className={s.doneFor}>for {result.nickname}</p>
        <ul className={s.doneList}>
          {result.lines.map((l) => (
            <li key={l.name}>
              {l.qty} {l.name}
              {l.freeQty > 0 ? ` (${l.freeQty} free)` : ''}
            </li>
          ))}
        </ul>
        <p className={s.doneFine}>
          {result.freeLeft} free mocktail{result.freeLeft === 1 ? '' : 's'} left, {result.pointsSpent > 0 ? `${result.pointsSpent} pts taken, ` : ''}
          {result.balance} pts left
        </p>
        {result.duplicate && <p className={s.doneFine}>(already done a moment ago, not charged twice)</p>}
        <Button tone="ink" size="lg" block onClick={onNext}>
          next person
        </Button>
      </motion.div>
    </main>
  );
}

/*
  The phone celebrates the moment a shopkeeper hands something over: confetti, "enjoy your mocktail!",
  and the free-drink glasses with the used one emptying. Mounted over the whole attendee app, so it
  fires wherever you are (the QR screen, the home screen, a game). Voids get a quiet note instead.
*/
import type { RedeemedEvent } from '@afterhours/shared/features/stalls';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useLiveEvent } from '../../core/live';
import { celebrate } from '../../fun';
import { Button, Card, Mascot, useToast } from '../../kit';
import { Mocktail, linesText } from './parts';
import s from './stalls.module.css';

function Reveal({ ev, onClose }: { ev: RedeemedEvent; onClose: () => void }) {
  const reduce = useReducedMotion();
  const [used, setUsed] = useState(false);
  const total = ev.freeLeft + ev.freeUsed;
  useEffect(() => {
    const a = window.setTimeout(() => setUsed(true), reduce ? 50 : 650);
    const b = window.setTimeout(onClose, 11_000);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [onClose, reduce]);
  const tones = ['pink', 'lime', 'sky', 'tangerine'] as const;
  const title = ev.freeUsed > 0 ? 'enjoy your mocktail!' : 'enjoy!';
  return (
    <motion.div className={s.celebrate} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} role="alertdialog" aria-label={title}>
      <motion.div initial={reduce ? false : { scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 17 }} onClick={(e) => e.stopPropagation()}>
        <Card tone="lime" tape tapeColor="pink" className={s.celebrateCard}>
          <Mascot size={70} mood="wow" follow={false} />
          <h2 className={s.celebrateTitle}>{title}</h2>
          <p className={s.celebrateWhat}>{linesText(ev.lines)}</p>
          {total > 0 && (
            <div className={s.celebrateGlasses} aria-hidden="true">
              {Array.from({ length: total }, (_, i) => (
                <Mocktail key={i} full={i < ev.freeLeft || (i >= ev.freeLeft && !used)} size={58} tone={tones[i % tones.length] ?? 'pink'} />
              ))}
            </div>
          )}
          <p className={s.celebrateLeft}>{ev.freeUsed > 0 ? (ev.freeLeft > 0 ? `${ev.freeLeft} free left` : "that was your last free one") : ''}</p>
          <p className={s.fine}>{ev.pointsSpent > 0 ? `-${ev.pointsSpent} points, ${ev.balance} to spend` : `${ev.balance} points to spend`}</p>
          <Button tone="ink" block onClick={onClose} icon="check">
            nice
          </Button>
        </Card>
      </motion.div>
    </motion.div>
  );
}

export function StallsOverlay() {
  const qc = useQueryClient();
  const toast = useToast();
  const [ev, setEv] = useState<RedeemedEvent | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['stalls'] });

  useLiveEvent('stalls.redeemed', (d) => {
    refresh();
    setEv(d);
    celebrate();
  });
  useLiveEvent('stalls.voided', (d) => {
    refresh();
    toast(`${d.stallName} voided a purchase. your points and drinks are back.`, { kind: 'info', title: 'refunded' });
  });
  return (
    <AnimatePresence>
      {ev && <Reveal key={ev.txnId} ev={ev} onClose={() => setEv(null)} />}
    </AnimatePresence>
  );
}

/* Projector: the giant rotating code, a draining ring to rotatesAt, the QR, a rolling count and welcome chips. */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { useServerNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { NumberTicker, ProgressRing, Qr } from '../../kit';
import s from './attendance.module.css';
import { useScreenCheckins } from './status';

export default function CheckinScene() {
  const q = useScreenCheckins();
  const now = useServerNow(250);
  const reduce = useReducedMotion();
  const [names, setNames] = useState<string[]>([]);
  useLiveEvent('attendance.arrivals', (d) => setNames((l) => [...l, ...d.names].slice(-14)));
  const c = q.data?.open[0];
  if (!c) return null;
  const windowMs = q.data?.windowMs ?? 30_000;
  const left = Math.max(0, c.rotatesAt - now);
  return (
    <div className={s.scene}>
      <div className={s.sceneLeft}>
        <span className={s.sceneKicker}>check in for</span>
        <h2 className={s.sceneTitle}>{c.title}</h2>
        <AnimatePresence mode="popLayout">
          <motion.div key={c.code} className={s.bigCode} initial={reduce ? { opacity: 0 } : { rotateX: -90, opacity: 0 }} animate={{ rotateX: 0, opacity: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 18 }}>
            {c.code.split('').map((ch, i) => (
              <motion.span
                key={i}
                className={s.bigChar}
                initial={reduce ? { opacity: 0 } : { rotateX: -100, y: -40, opacity: 0 }}
                animate={{ rotateX: 0, y: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 14, delay: reduce ? 0 : i * 0.09 }}
              >
                {ch}
              </motion.span>
            ))}
          </motion.div>
        </AnimatePresence>
        <div className={s.ringRow}>
          <div className={left < 6000 ? s.ringHot : undefined}>
            <ProgressRing value={left / windowMs} size={170} thickness={20} tone={left < 6000 ? 'pink' : 'lime'} label="code changes in">
              <span className={s.ringNum}>{Math.ceil(left / 1000)}</span>
            </ProgressRing>
          </div>
          type it in the app, or scan the square
        </div>
        <div className={s.chips}>
          <AnimatePresence initial={false}>
            {names.slice(-8).map((n, i) => (
              <motion.span
                key={`${n}-${names.length - 8 + i}`}
                layout={!reduce}
                className={s.chip}
                initial={reduce ? { opacity: 0 } : { scale: 0, rotate: -24, y: 30 }}
                animate={{ scale: 1, rotate: ((i * 5) % 7) - 3, y: 0 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ type: 'spring', stiffness: 560, damping: 13 }}
              >
                welcome {n}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <div className={s.sceneRight}>
        <div className={s.qrBox}>
          <Qr text={c.qrUrl} size={460} label="check-in QR" />
        </div>
        <span className={s.sceneCount}>
          <NumberTicker value={c.count} /> in the room
        </span>
      </div>
    </div>
  );
}


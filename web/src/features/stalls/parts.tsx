/*
  Small pieces shared by the phone wallet, the shopkeeper surface and the console:
  the mocktail doodle, a stall's mark (emoji or doodle), item thumbnails, and a few formatters.
*/
import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import { Doodle, type IconName } from '../../kit';
import s from './stalls.module.css';

/* the potion bottle's flask: a long neck into a round body */
const FLASK = 'M26 16V36A26 26 0 1 0 38 36V16Z';
const POTION: Record<'pink' | 'lime' | 'sky' | 'tangerine', string> = { pink: 'var(--enamel-pink)', lime: 'var(--enamel-lime)', sky: 'var(--enamel-sky)', tangerine: 'var(--enamel-tangerine)' };

/** A mocktail, drawn as a potion bottle. `full` shows the potion; used-up bottles are an empty dashed outline. */
export function Mocktail({ full = true, size = 72, tone = 'pink', wobble = false }: { full?: boolean; size?: number; tone?: 'pink' | 'lime' | 'sky' | 'tangerine'; wobble?: boolean }) {
  const reduce = useReducedMotion();
  const clip = useId();
  return (
    <motion.svg
      viewBox="0 0 64 96"
      width={size}
      height={(size * 96) / 64}
      aria-hidden="true"
      className={s.glass}
      animate={wobble && !reduce ? { rotate: [0, -6, 5, -3, 0] } : { rotate: 0 }}
      transition={{ duration: 0.9, repeat: wobble && !reduce ? Infinity : 0, repeatDelay: 1.6 }}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <clipPath id={clip}>
          <path d={FLASK} />
        </clipPath>
      </defs>
      {/* potion: drains away when used */}
      <g clipPath={`url(#${clip})`}>
        <motion.rect x="0" width="64" height="70" fill={POTION[tone]} initial={false} animate={{ y: full ? 46 : 96 }} transition={reduce ? { duration: 0.1 } : { type: 'spring', stiffness: 160, damping: 18 }} />
        {full && (
          <>
            <ellipse cx="32" cy="47" rx="30" ry="2.5" fill="#fff" opacity="0.25" />
            <circle cx="24" cy="66" r="3" fill="#fff" opacity="0.45" />
            <circle cx="40" cy="74" r="2.2" fill="#fff" opacity="0.4" />
            <circle cx="34" cy="58" r="1.8" fill="#fff" opacity="0.5" />
          </>
        )}
        {/* glass shine */}
        <path d="M14 58a20 20 0 0 1 8-14" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" />
      </g>
      <path d={FLASK} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" strokeDasharray={full ? undefined : '6 5'} opacity={full ? 1 : 0.55} />
      {/* the lip, the cork and its string */}
      <path d="M23 16h18" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" opacity={full ? 1 : 0.55} />
      {full && (
        <>
          <rect x="26" y="5" width="12" height="11" rx="2" fill="var(--cork, #9a6a35)" stroke="var(--ink)" strokeWidth="2" />
          <path d="M38 20q8 2 6 10" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M42 28l4 4-4 4-4-4z" fill="var(--gold)" stroke="var(--ink)" strokeWidth="1.2" />
        </>
      )}
    </motion.svg>
  );
}

/** Points as gold coins: a little stack and one on its edge. */
export function GoldCoins({ size = 56 }: { size?: number }) {
  const coin = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <ellipse cx={x} cy={y + 3} rx="15" ry="5.5" fill="var(--coin-edge, #8a6420)" stroke="var(--coin-line, #4a3410)" strokeWidth="1.2" />
      <ellipse cx={x} cy={y} rx="15" ry="5.5" fill="var(--coin, #e8c26a)" stroke="var(--coin-line, #4a3410)" strokeWidth="1.2" />
      <ellipse cx={x} cy={y} rx="9" ry="3.1" fill="none" stroke="var(--coin-line, #4a3410)" strokeWidth="0.8" opacity="0.6" />
    </g>
  );
  return (
    <svg viewBox="0 0 64 56" width={size} height={(size * 56) / 64} aria-hidden="true" style={{ overflow: 'visible', flex: 'none' }}>
      {[44, 38, 32, 26].map((y) => coin(22, y))}
      <g transform="translate(46 34)">
        <circle r="13" fill="var(--coin, #e8c26a)" stroke="var(--coin-line, #4a3410)" strokeWidth="1.4" />
        <circle r="9" fill="none" stroke="var(--coin-line, #4a3410)" strokeWidth="0.9" opacity="0.7" />
        <path d="M0-6L1.5-1.5L6 0L1.5 1.5L0 6L-1.5 1.5L-6 0L-1.5-1.5Z" fill="var(--coin-line, #4a3410)" />
      </g>
    </svg>
  );
}

/** A stall's mark: an emoji, or `doodle:<icon>` from the kit. */
export function StallMark({ value, size = 28 }: { value: string; size?: number }) {
  if (value.startsWith('doodle:')) return <Doodle name={(value.slice(7) || 'star') as IconName} size={size} fill="var(--sun)" />;
  return (
    <span className={s.emoji} style={{ fontSize: size }} aria-hidden="true">
      {value || '\u{1F379}'}
    </span>
  );
}

/** Item thumbnail: the photo if there is one, otherwise a tilted initial. */
export function Thumb({ src, name, size = 56 }: { src: string | null; name: string; size?: number }) {
  return src ? (
    <img src={src} alt="" className={s.thumb} width={size} height={size} loading="lazy" style={{ width: size, height: size }} />
  ) : (
    <span className={s.thumbFallback} style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export const pts = (n: number): string => `${n.toLocaleString('en-IN')} pt${n === 1 ? '' : 's'}`;

export const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

/** "2 mocktails, 1 tee": what a receipt line list reads like. */
export function linesText(lines: { name: string; qty: number }[]): string {
  return lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.name}` : l.name)).join(', ');
}

export async function fileToUpload(file: File, maxBytes = 280 * 1024): Promise<string> {
  const raw = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
  if (file.size <= maxBytes && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) return raw;
  // Too big or an odd format: redraw it smaller as a JPEG that fits.
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('That does not look like an image.'));
    i.src = raw;
  });
  let side = 720;
  for (let q = 0.85; q > 0.3; q -= 0.15, side *= 0.85) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', q);
    if ((out.length * 3) / 4 <= maxBytes) return out;
  }
  throw new Error('Could not shrink that image enough. Try a smaller one.');
}

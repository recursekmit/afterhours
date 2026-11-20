/*
  Small pieces shared by the phone wallet, the shopkeeper surface and the console:
  the mocktail doodle, a stall's mark (emoji or doodle), item thumbnails, and a few formatters.
*/
import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import { Doodle, type IconName } from '../../kit';
import s from './stalls.module.css';

/** A mocktail glass. `full` shows the drink; used-up glasses are an empty dashed outline. */
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
          <path d="M9 22h46l-5 52a6 6 0 0 1-6 5H20a6 6 0 0 1-6-5z" />
        </clipPath>
      </defs>
      {/* drink: slides down and away when used */}
      <g clipPath={`url(#${clip})`}>
        <motion.rect x="6" width="52" height="60" fill={`var(--${tone})`} initial={false} animate={{ y: full ? 32 : 84 }} transition={reduce ? { duration: 0.1 } : { type: 'spring', stiffness: 160, damping: 18 }} />
        {full && (
          <>
            <circle cx="24" cy="52" r="3" fill="var(--paper-3)" stroke="var(--ink)" strokeWidth="1.6" />
            <circle cx="38" cy="62" r="2.2" fill="var(--paper-3)" stroke="var(--ink)" strokeWidth="1.6" />
            <circle cx="33" cy="44" r="1.8" fill="var(--paper-3)" stroke="var(--ink)" strokeWidth="1.6" />
          </>
        )}
      </g>
      <path d="M9 22h46l-5 52a6 6 0 0 1-6 5H20a6 6 0 0 1-6-5z" fill="none" stroke="var(--ink)" strokeWidth="3.6" strokeLinejoin="round" strokeDasharray={full ? undefined : '6 5'} opacity={full ? 1 : 0.55} />
      <path d="M32 79v10M20 90h24" stroke="var(--ink)" strokeWidth="3.6" strokeLinecap="round" opacity={full ? 1 : 0.55} />
      {full && (
        <>
          <path d="M40 22L50 4" stroke="var(--ink)" strokeWidth="3.6" strokeLinecap="round" />
          <path d="M8 24a10 10 0 0 1 18 0z" fill="var(--lime)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
        </>
      )}
    </motion.svg>
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

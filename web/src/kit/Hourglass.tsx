/*
  Hourglass: a brass-framed sand glass. frac = time left, 0..1: the top bulb empties into the bottom.
    <Hourglass frac={0.6} size={48} />
  Pure decoration (aria-hidden): pair it with a real progressbar or number.
*/
import { useId } from 'react';

export function Hourglass({ frac, size = 48, running = true }: { frac: number; size?: number; running?: boolean }) {
  const f = Math.max(0, Math.min(1, frac));
  // sand heights inside the glass (viewBox 0 0 40 60): top bulb 8..28, bottom bulb 32..52
  const topY = 28 - 18 * f;
  const botY = 52 - 18 * (1 - f);
  const id = `hg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 40 60" width={size * (40 / 60)} height={size} aria-hidden="true" style={{ flex: 'none', overflow: 'visible' }}>
      <defs>
        <clipPath id={`${id}-top`}>
          <path d="M9 8H31C31 18 22 24 21 29H19C18 24 9 18 9 8Z" />
        </clipPath>
        <clipPath id={`${id}-bot`}>
          <path d="M19 31H21C22 36 31 42 31 52H9C9 42 18 36 19 31Z" />
        </clipPath>
      </defs>
      {/* glass */}
      <path d="M9 8H31C31 18 22 24 21 30C22 36 31 42 31 52H9C9 42 18 36 19 30C18 24 9 18 9 8Z" fill="rgb(255 250 235 / 0.12)" stroke="var(--frame, var(--gold))" strokeWidth="1.2" />
      {/* sand */}
      <rect x="0" y={topY} width="40" height={30 - topY} fill="var(--sand, #e2b45c)" clipPath={`url(#${id}-top)`} />
      <rect x="0" y={botY} width="40" height={53 - botY} fill="var(--sand, #e2b45c)" clipPath={`url(#${id}-bot)`} />
      {running && f > 0 && f < 1 && <line x1="20" y1="29" x2="20" y2={botY} stroke="var(--sand, #e2b45c)" strokeWidth="1.2" strokeDasharray="2 2" />}
      {/* brass caps and posts */}
      <rect x="4" y="3" width="32" height="5" rx="1.5" fill="var(--gold)" stroke="var(--frame, var(--gold))" />
      <rect x="4" y="52" width="32" height="5" rx="1.5" fill="var(--gold)" stroke="var(--frame, var(--gold))" />
      <path d="M6 8V52M34 8V52" stroke="var(--gold)" strokeWidth="1.8" />
    </svg>
  );
}

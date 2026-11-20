/*
  Doodle: the hand-drawn icon + glyph set. One component, one 24x24 grid,
  ink stroke with round ends and deliberately uneven paths.
  Shared stickers/avatars name glyphs from @afterhours/shared (Glyph); the
  rest are UI icons. Use <Doodle name="bell" /> instead of any icon library.
*/
import type { Glyph } from '@afterhours/shared';
import type { CSSProperties, ReactNode } from 'react';

export type UiIcon =
  | 'home' | 'book' | 'users' | 'print' | 'download' | 'sound' | 'mute' | 'close' | 'plus' | 'qr' | 'cog'
  | 'bars' | 'bell' | 'clock' | 'gamepad' | 'screen' | 'dice' | 'phone' | 'copy' | 'search' | 'undo' | 'lock'
  | 'morse' | 'ticket' | 'scissors' | 'share' | 'megaphone' | 'trophy' | 'pin' | 'play' | 'list';
export type IconName = Glyph | UiIcon;

type Draw = (fill: string) => ReactNode;

const P = ({ d, f }: { d: string; f?: string }) => <path d={d} fill={f ?? 'none'} />;

const ICONS: Record<IconName, Draw> = {
  // the tickets' four-point star
  star: (f) => <P f={f} d="M12 1.8l2.3 7.4 7.5 2.8-7.5 2.8L12 22.2l-2.3-7.4L2.2 12l7.5-2.8z" />,
  // a shooting star (not a lightning bolt): the flash drops and "fast" glyph
  bolt: (f) => (
    <>
      <P f={f} d="M15.2 2l1.7 5.1 5.1 1.7-5.1 1.7-1.7 5.1-1.7-5.1-5.1-1.7 5.1-1.7z" />
      <path d="M9.6 13.6L2.8 20.4M7.4 12.4L3.4 16.4M11.4 16.2L7.6 20" />
    </>
  ),
  heart: (f) => <P f={f} d="M12 20.6C5.2 15.6 3 12.2 3 8.8 3 6 5 4.2 7.4 4.3c1.8 0 3.4 1 4.6 2.8 1.2-1.8 2.8-2.8 4.6-2.8C19 4.2 21 6 21 8.8c0 3.4-2.200 6.800-9 11.800z" />,
  eye: (f) => (
    <>
      <P f={f} d="M2.2 12c3-5 6-7 9.8-7s6.8 2 9.800 7c-3 5-6 7-9.800 7S5.200 17 2.200 12z" />
      <circle cx="12" cy="12" r="3.3" fill="var(--ink)" />
    </>
  ),
  key: (f) => (
    <>
      <circle cx="7.5" cy="12" r="4.3" fill={f} />
      <path d="M12 12.2h9.5M17.5 12.2v3.6M20.8 12.2v2.6" />
    </>
  ),
  flag: (f) => (
    <>
      <path d="M5 21.5V3" />
      <P f={f} d="M5 4.2c4.2-2.2 7.2 2 14 .2v9.2c-6.8 1.8-9.8-2-14-.2" />
    </>
  ),
  note: (f) => (
    <>
      <path d="M9.2 18V5.2l11-2.2v13" />
      <circle cx="6.6" cy="18" r="2.8" fill={f} />
      <circle cx="17.6" cy="16" r="2.8" fill={f} />
    </>
  ),
  smile: (f) => (
    <>
      <circle cx="12" cy="12" r="9.2" fill={f} />
      <path d="M8.2 9.5v1.4M15.8 9.5v1.4" strokeWidth="2.6" />
      <path d="M7.6 14.2c2 3.4 6.8 3.4 8.8 0" />
    </>
  ),
  robot: (f) => (
    <>
      <path d="M12 7.8V4.2" />
      <circle cx="12" cy="3.2" r="1.5" fill="var(--ink)" />
      <rect x="4" y="7.8" width="16" height="12.7" rx="5" fill={f} />
      <circle cx="9" cy="13.8" r="1.7" fill="var(--ink)" />
      <circle cx="15" cy="13.8" r="1.7" fill="var(--ink)" />
      <path d="M9.5 17.5h5" />
    </>
  ),
  crown: (f) => <P f={f} d="M3.2 18.5L2.6 7.2l5.4 4.5L12 4l4 7.7 5.4-4.5-.6 11.3z" />,
  flame: (f) => <P f={f} d="M12.2 2.4c1.2 4.2 6 6.2 6 12.1a6.2 6.2 0 0 1-12.4 0c0-3 1.6-4.7 2.9-6.2.2 2 1.2 2.8 2 3.2-.3-3.2-.9-5.6 1.5-9.100z" />,
  check: () => <path d="M3.8 12.8l5.2 5.2L20.4 5.8" strokeWidth="3" />,
  spark: (f) => <P f={f} d="M12 2c.9 5.2 2.6 8.2 8.2 10-5.6 1.900-7.300 5-8.200 10-.9-5-2.600-8.100-8.200-10C9.400 10.200 11.100 7.200 12 2z" />,
  wave: () => <path d="M1.8 12.4c2.6-5.4 4.6-5.4 6.1 0s3.5 5.4 6.1 0 4.6-5.4 8.2 0" strokeWidth="2.6" />,
  arrow: () => <path d="M2.8 13.2c6.2-1.4 11.4-1.2 17.4-.4M14 5.6l7 6.8-7.400 6" strokeWidth="2.6" />,
  ghost: (f) => (
    <>
      <P f={f} d="M5 21.5V11.2a7 7 0 0 1 14 0v10.300l-2.400-2.300-2.300 2.300-2.300-2.300-2.400 2.300-2.300-2.300z" />
      <circle cx="9.6" cy="11" r="1.2" fill="var(--ink)" />
      <circle cx="14.6" cy="11" r="1.2" fill="var(--ink)" />
    </>
  ),
  map: (f) => (
    <>
      <P f={f} d="M3 6.2l6-2.6 6 2.6 6-2.6v14.6l-6 2.6-6-2.6-6 2.6z" />
      <path d="M9 3.6v14.6M15 6.2v14.6" />
    </>
  ),
  dot: (f) => <circle cx="12" cy="12" r="5.2" fill={f === 'none' ? 'var(--ink)' : f} />,

  home: (f) => <P f={f} d="M3 11.6L12 3.4l9 8.2M5.4 10v10.6h13.2V10" />,
  book: (f) => (
    <>
      <P f={f} d="M5 3.4h14.200v17H5z" />
      <path d="M14 20.4c0-3 1.200-4.700 5.200-4.700" />
      <path d="M8.400 8h6M8.400 11.400h4" />
    </>
  ),
  users: (f) => (
    <>
      <circle cx="9" cy="8.4" r="3.4" fill={f} />
      <path d="M2.800 20c.4-4 3-5.800 6.200-5.800s5.800 1.800 6.200 5.800" />
      <circle cx="17" cy="9.2" r="2.6" fill={f} />
      <path d="M17.400 14.600c2.400.2 3.800 1.800 4 4.400" />
    </>
  ),
  print: (f) => (
    <>
      <path d="M7 8V3.500h10V8" />
      <P f={f} d="M5 8h14a2 2 0 0 1 2 2v6h-4v4.500H7V16H3v-6a2 2 0 0 1 2-2z" />
      <path d="M8.500 14h7" />
    </>
  ),
  download: () => <path d="M12 3.500v12M6.400 10.400L12 16l5.600-5.600M4 20.500h16" strokeWidth="2.600" />,
  sound: (f) => (
    <>
      <P f={f} d="M3.800 9.400h4L13 5v14l-5.200-4.400h-4z" />
      <path d="M16.400 8.600c1.800 2 1.800 4.800 0 6.800M19.200 6c3 3.600 3 8.200 0 12" />
    </>
  ),
  mute: (f) => (
    <>
      <P f={f} d="M3.800 9.400h4L13 5v14l-5.200-4.400h-4z" />
      <path d="M16.600 9.200l5.200 5.600M21.800 9.200l-5.200 5.600" />
    </>
  ),
  close: () => <path d="M5.200 5.200l13.800 13.600M19 5L5.400 19" strokeWidth="3" />,
  plus: () => <path d="M12 4.200v15.600M4.200 12h15.600" strokeWidth="3" />,
  qr: (f) => (
    <>
      <rect x="3.400" y="3.400" width="6.800" height="6.800" rx="1" fill={f} />
      <rect x="13.800" y="3.400" width="6.800" height="6.800" rx="1" fill={f} />
      <rect x="3.400" y="13.800" width="6.800" height="6.800" rx="1" fill={f} />
      <path d="M14 14h2.600v2.600H14zM18.400 18.400h2.200M18.200 14h2.400" />
    </>
  ),
  cog: (f) => (
    <>
      <circle cx="12" cy="12" r="4.200" fill={f} />
      <path d="M12 2.600v3.200M12 18.200v3.200M2.600 12h3.200M18.200 12h3.200M5.400 5.400l2.200 2.200M16.400 16.400l2.200 2.200M18.600 5.400l-2.200 2.200M7.600 16.400l-2.200 2.200" />
    </>
  ),
  bars: () => <path d="M5.400 20.500v-9M12 20.500V3.800M18.600 20.500v-6" strokeWidth="4" />,
  bell: (f) => (
    <>
      <P f={f} d="M5.800 17.200v-6a6.200 6.200 0 0 1 12.400 0v6l2 2.200H3.800z" />
      <path d="M9.800 21.600h4.400" />
    </>
  ),
  clock: (f) => (
    <>
      <circle cx="12" cy="12" r="9.200" fill={f} />
      <path d="M12 6.400V12l3.800 2.200" />
    </>
  ),
  gamepad: (f) => (
    <>
      <P f={f} d="M6.400 7.200h11.200a4.600 4.600 0 0 1 4.600 5l-.6 4.400a2.800 2.800 0 0 1-4.800 1.600L14.600 16H9.400l-2.200 2.200A2.800 2.800 0 0 1 2.400 16.600l-.6-4.400a4.600 4.600 0 0 1 4.600-5z" />
      <path d="M7.200 10.400v3.200M5.600 12h3.200" />
      <circle cx="16" cy="10.800" r=".6" fill="var(--ink)" />
      <circle cx="18" cy="12.800" r=".6" fill="var(--ink)" />
    </>
  ),
  screen: (f) => (
    <>
      <P f={f} d="M2.800 4.600h18.400v12H2.800z" />
      <path d="M8 20.800h8M12 16.800v4" />
    </>
  ),
  dice: (f) => (
    <>
      <rect x="3.400" y="3.400" width="17.200" height="17.200" rx="4" fill={f} />
      <circle cx="8.400" cy="8.400" r="1.300" fill="var(--ink)" />
      <circle cx="15.600" cy="15.600" r="1.300" fill="var(--ink)" />
      <circle cx="12" cy="12" r="1.300" fill="var(--ink)" />
      <circle cx="15.600" cy="8.400" r="1.300" fill="var(--ink)" />
      <circle cx="8.400" cy="15.600" r="1.300" fill="var(--ink)" />
    </>
  ),
  phone: (f) => (
    <>
      <rect x="6.400" y="2.600" width="11.200" height="18.800" rx="2.800" fill={f} />
      <path d="M10.600 18.400h2.800" />
    </>
  ),
  copy: (f) => (
    <>
      <rect x="8.800" y="8.800" width="12" height="12" rx="2" fill={f} />
      <path d="M15.200 5.600V3.800H3.800v11.400h2" />
    </>
  ),
  search: (f) => (
    <>
      <circle cx="10.400" cy="10.400" r="6.600" fill={f} />
      <path d="M15.400 15.400l5.800 5.800" strokeWidth="3" />
    </>
  ),
  undo: () => <path d="M4.400 12.200a8 8 0 1 0 2.600-6.400M4 3.800v5.400h5.400" strokeWidth="2.600" />,
  lock: (f) => (
    <>
      <path d="M7.400 10.600V7.800a4.600 4.600 0 0 1 9.200 0v2.800" />
      <rect x="4.600" y="10.400" width="14.800" height="10.600" rx="2.600" fill={f} />
      <circle cx="12" cy="15.600" r="1.300" fill="var(--ink)" />
    </>
  ),
  morse: () => <path d="M2.600 12h2.200M8.200 12h6.400M18 12h.1M21.400 12h.1" strokeWidth="3.600" />,
  ticket: (f) => (
    <>
      <P f={f} d="M2.800 6.800h18.400v3.400a2.200 2.200 0 0 0 0 4.200v3.400H2.800v-3.400a2.200 2.200 0 0 0 0-4.200z" />
      <path d="M15 7.400v1.600M15 11.200v1.600M15 15v1.600" />
    </>
  ),
  scissors: () => (
    <>
      <circle cx="6.400" cy="6.600" r="2.800" />
      <circle cx="6.400" cy="17.400" r="2.800" />
      <path d="M8.800 8.200L21 17.400M8.800 15.800L21 6.600" />
    </>
  ),
  share: () => <path d="M12 15V3.600M7 8.200l5-4.800 5 4.800M5 12.400v8h14v-8" strokeWidth="2.600" />,
  megaphone: (f) => (
    <>
      <P f={f} d="M3.600 9.600h4.600L17.800 4v16L8.200 14.400H3.600z" />
      <path d="M8 14.600l1.400 5.200h3" />
      <path d="M20.400 9.400v5.200" />
    </>
  ),
  trophy: (f) => (
    <>
      <P f={f} d="M7 3.600h10v6a5 5 0 0 1-10 0z" />
      <path d="M7 5.400H3.600c0 3 1.200 4.400 3.600 4.800M17 5.400h3.400c0 3-1.200 4.400-3.600 4.800M12 14.600v3.600M8 20.600h8" />
    </>
  ),
  pin: (f) => (
    <>
      <P f={f} d="M12 21.600s-6.600-6-6.600-11a6.600 6.600 0 0 1 13.200 0c0 5-6.600 11-6.600 11z" />
      <circle cx="12" cy="10.400" r="2.400" fill="var(--paper-3)" />
    </>
  ),
  play: (f) => <P f={f} d="M7 4.200l12.400 7.800L7 19.800z" />,
  list: () => <path d="M8.800 6.400h12M8.800 12h12M8.800 17.600h12M3.600 6.400h.1M3.600 12h.1M3.600 17.600h.1" strokeWidth="2.800" />,
};

export interface DoodleProps {
  name: IconName;
  size?: number | string;
  /** Fill colour for closed shapes. A token like 'var(--lime)'. Default: none. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible label. Omit for decorative icons. */
  title?: string;
}

export function Doodle({ name, size = 24, fill = 'none', stroke = 'var(--ink)', strokeWidth = 2.2, className, style, title }: DoodleProps) {
  const draw = ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {draw(fill)}
    </svg>
  );
}

/**
 * The engraved underline: a double rule, a four-point star and a tapering tail, in the frame gold.
 * (Was a marker squiggle; `color` is kept for the API and ignored so every title reads as one engraving.)
 */
export function Scribble({ className, style }: { color?: string; className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 200 14" preserveAspectRatio="xMinYMid meet" className={className} style={{ width: '100%', height: 12, color: 'var(--frame, var(--gold))', ...style }} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M2 5H70M2 9H70" strokeWidth="1.1" />
        <path d="M94 7H150" strokeWidth="1.3" />
        <path d="M150 7H186" strokeWidth="0.8" opacity="0.7" />
      </g>
      <path d="M82 0L83.6 5.4L89 7L83.6 8.6L82 14L80.4 8.6L75 7L80.4 5.4Z" fill="currentColor" />
      <circle cx="192" cy="7" r="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * Global SVG filter defs: a gentle hand-wobble for outlines (`filter: url(#ah-wobble)`)
 * and a rougher one for tape/paper edges (`#ah-rough`). Mounted once by each surface.
 */
export function DoodleDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <filter id="ah-wobble" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" />
        </filter>
        <filter id="ah-rough" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="2" seed="9" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4.5" />
        </filter>
        <linearGradient id="ah-pin-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbe7b0" />
          <stop offset="0.45" stopColor="#c99a45" />
          <stop offset="0.7" stopColor="#8a6420" />
          <stop offset="1" stopColor="#e8c578" />
        </linearGradient>
        <linearGradient id="ah-pin-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ah-wax" cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" stopColor="#c0453f" />
          <stop offset="0.55" stopColor="#8e1f24" />
          <stop offset="1" stopColor="#5a0f14" />
        </radialGradient>
        <pattern id="ah-sticker-dots" width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="1" fill="#fff" fillOpacity="0.35" />
        </pattern>
      </defs>
    </svg>
  );
}

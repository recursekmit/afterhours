/*
  Personality doodles: one hand-inked drawing per after hours personality.
  Ink strokes, flat token fills (the share image swaps the tokens for their values).
*/
import type { PersonalityId } from '@afterhours/shared/features/recap';
import type { ComponentType, CSSProperties, Ref } from 'react';

const INK = 'var(--ink)';
const PAPER = 'var(--paper-3)';
const line = { fill: 'none', stroke: INK, strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const shape = { stroke: INK, strokeWidth: 4, strokeLinejoin: 'round' as const };

function Decoder() {
  return (
    <>
      {/* headphones */}
      <path d="M22 70Q18 22 60 20Q102 22 98 70" {...line} strokeWidth={7} />
      <path d="M14 62Q14 56 21 56H30Q34 56 34 61V88Q34 93 29 93H21Q14 93 14 87z" fill="var(--sun)" {...shape} />
      <path d="M106 62Q106 56 99 56H90Q86 56 86 61V88Q86 93 91 93H99Q106 93 106 87z" fill="var(--sun)" {...shape} />
      {/* dit dah dit spilling out */}
      <circle cx="46" cy="62" r="5" fill={INK} />
      <path d="M56 62H72" {...line} strokeWidth={8} />
      <circle cx="46" cy="78" r="5" fill={INK} />
      <circle cx="60" cy="78" r="5" fill={INK} />
      <path d="M68 78H78" {...line} strokeWidth={8} />
      <path d="M50 96H66" {...line} strokeWidth={8} />
      <path d="M96 30L104 22M100 40L112 38M88 24L90 12" {...line} strokeWidth={3.5} />
    </>
  );
}

function Explorer() {
  return (
    <>
      <path d="M12 28L42 18L78 30L108 20V92L78 102L42 90L12 100z" fill={PAPER} {...shape} />
      <path d="M42 18V90M78 30V102" {...line} strokeWidth={3} />
      <path d="M22 84Q34 70 30 58T52 44Q66 40 62 58T88 56" {...line} strokeWidth={3.5} strokeDasharray="2 8" />
      <path d="M84 50L96 62M96 50L84 62" {...line} stroke="var(--pink)" strokeWidth={6} />
      <circle cx="22" cy="84" r="5" fill="var(--lime)" stroke={INK} strokeWidth={3} />
      <path d="M100 4L103 12L111 14L103 17L100 25L97 17L89 14L97 12z" fill="var(--sun)" {...shape} strokeWidth={2.5} />
    </>
  );
}

function Speedrunner() {
  return (
    <>
      <path d="M36 54Q38 40 52 42L64 46Q72 30 84 36Q88 46 82 54L104 66Q112 72 106 82L100 88H28Q20 88 22 78z" fill="var(--tangerine)" {...shape} />
      <path d="M22 80H104" {...line} strokeWidth={3} />
      <path d="M26 92H102" {...line} strokeWidth={6} />
      <path d="M50 58L56 62M58 54L64 58M66 50L72 54" {...line} strokeWidth={3} />
      <path d="M4 50H22M2 64H18M8 76H20" {...line} strokeWidth={4} />
      <path d="M78 4L64 26H76L68 44L92 18H80L88 4z" fill="var(--sun)" {...shape} strokeWidth={3} />
    </>
  );
}

function CrowdPleaser() {
  return (
    <>
      <path d="M18 54L62 30V94L18 74z" fill="var(--pink)" {...shape} />
      <path d="M10 56Q8 64 10 72L18 74V54z" fill={PAPER} {...shape} />
      <path d="M30 78L36 100Q38 106 44 104L50 102Q54 100 52 94L46 82" fill={PAPER} {...shape} />
      <path d="M74 46Q84 62 74 78M84 36Q100 62 84 88M94 26Q116 62 94 98" {...line} strokeWidth={4} />
      <path d="M100 6L103 13L110 15L103 18L100 25L97 18L90 15L97 13z" fill="var(--sun)" {...shape} strokeWidth={2.5} />
      <path d="M26 16L28 22L34 23L28 25L26 31L24 25L18 23L24 22z" fill="var(--lime)" {...shape} strokeWidth={2.2} />
    </>
  );
}

function Mystery() {
  return (
    <>
      <path d="M26 104V52Q26 16 60 16Q94 16 94 52V104L82 94L70 104L60 94L50 104L38 94z" fill={PAPER} {...shape} />
      <circle cx="46" cy="50" r="6" fill={INK} />
      <circle cx="74" cy="50" r="6" fill={INK} />
      <path d="M52 70Q60 64 68 70" {...line} />
      <path d="M98 14Q108 4 114 14Q118 24 106 28V34" {...line} strokeWidth={4} />
      <circle cx="106" cy="44" r="3" fill={INK} />
      <path d="M8 40L12 48M4 54L12 56" {...line} strokeWidth={3} />
    </>
  );
}

const ART: Record<PersonalityId, ComponentType> = {
  decoder: Decoder,
  explorer: Explorer,
  speedrunner: Speedrunner,
  'crowd-pleaser': CrowdPleaser,
  mystery: Mystery,
};

export function PersonalityDoodle({ id, size = 160, className, style, svgRef }: { id: PersonalityId; size?: number; className?: string; style?: CSSProperties; svgRef?: Ref<SVGSVGElement> }) {
  const Art = ART[id];
  return (
    <svg ref={svgRef} viewBox="0 0 120 120" width={size} height={size} className={className} style={{ overflow: 'visible', ...style }} aria-hidden="true">
      <Art />
    </svg>
  );
}

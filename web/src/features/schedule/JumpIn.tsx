/* A "jump in" button with a springy press and a nudging arrow. */
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode } from 'react';
import { type Tone, LinkButton } from '../../kit';
import s from './schedule.module.css';

export function JumpIn({ to, tone = 'lime', children, className }: { to: string; tone?: Tone; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      className={`${s.jumpWrap} ${className ?? ''}`}
      whileTap={reduce ? { scale: 0.96 } : { scale: 0.86, rotate: -4 }}
      whileHover={reduce ? undefined : { scale: 1.06, rotate: 1.5 }}
      transition={{ type: 'spring', stiffness: 700, damping: 11 }}
    >
      <LinkButton to={to} tone={tone} size="sm" icon="arrow" className={s.jumpBtn}>
        {children}
      </LinkButton>
    </motion.span>
  );
}

/*
  Sheet / Modal. A paper sheet that slides up (or pops in the centre). Drag the
  handle down to dismiss, tap outside, or press Esc.
    <Sheet open={open} onClose={() => setOpen(false)} title="reset kit?">...</Sheet>
    <Modal ...>   // centred
*/
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { sfx } from '../fun/sfx';
import { IconButton } from './Button';
import s from './kit.module.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  placement?: 'bottom' | 'center';
  children?: ReactNode;
  /** Set false for forced choices (no close button, no tap-outside). */
  dismissable?: boolean;
}

export function Sheet({ open, onClose, title, placement = 'bottom', dismissable = true, children }: SheetProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const center = placement === 'center';

  useEffect(() => {
    if (!open) return;
    sfx.whoosh();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open, onClose, dismissable]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={`${s.backdrop} ${center ? s['backdrop-center'] : ''}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget && dismissable) onClose();
          }}
        >
          <motion.div
            ref={ref}
            role="dialog"
            data-ground="parchment"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className={`${s.sheet} ${center ? s['sheet-center'] : ''}`}
            initial={reduce ? { opacity: 0 } : center ? { scale: 0.9, opacity: 0 } : { y: '100%' }}
            animate={center ? { scale: 1, rotate: 0, opacity: 1, y: 0 } : { y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : center ? { scale: 0.8, opacity: 0 } : { y: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            drag={!center && dismissable && !reduce ? 'y' : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
          >
            {!center && (
              <svg className={s.sheetGrip} viewBox="0 0 64 10" aria-hidden="true">
                <path d="M3 6Q16 0 32 5T61 4" fill="none" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
              </svg>
            )}
            {dismissable && <IconButton icon="close" label="close" size="sm" className={s.sheetClose} onClick={onClose} quiet />}
            {title && <h2 className={s.sheetTitle}>{title}</h2>}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Modal(props: Omit<SheetProps, 'placement'>) {
  return <Sheet {...props} placement="center" />;
}

/*
  Printable sheets for a trail, cut along the dashes:
  - StickerSheet: a QR sticker per stop (QR + typed code + title + location), Recurse mark.
  - MorseCards: a card per Morse stop to stick on an object: the word as big, clean dots and
    dashes from the shared Morse table, an optional small QR (require-scan stops), the club mark,
    and the stop title in small print for organisers.
*/
import { HuntStickerSheetSchema, MorseCardSheetSchema } from '@afterhours/shared/features/hunt';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../core/api';
import { Button, Qr, RecurseLogo } from '../../kit';
import { ui } from '../common/ui';
import s from './hunt.module.css';

function PrintBar({ onClose, note }: { onClose: () => void; note: string }) {
  return (
    <div className={`${ui.row} ${s.noPrint}`}>
      <Button tone="lime" icon="print" onClick={() => window.print()}>
        print
      </Button>
      <Button tone="paper" ghost onClick={onClose}>
        back
      </Button>
      <span className={ui.hand}>{note}</span>
    </div>
  );
}

export function StickerSheet({ trail, onClose }: { trail: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['hunt', 'stickers', trail], queryFn: () => api.get(`/api/hunt/admin/stickers?trail=${trail}`, HuntStickerSheetSchema) });
  return (
    <div className={ui.stack}>
      <PrintBar onClose={onClose} note="cut along the dashes. each QR opens the app on that stop; the code under it is the typed fallback." />
      <div className={s.sheet}>
        {q.data?.stops.map((st) => (
          <div key={st.stopId} className={s.sticker}>
            <RecurseLogo height={18} />
            <Qr text={st.url} size={180} label={`QR for ${st.title}`} />
            <span className={s.stickerCode}>{st.code}</span>
            <span className={s.stickerTitle}>
              #{st.position} {st.title}
            </span>
            {st.location && <span className={s.stickerLoc}>{st.location}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One letter as printed: dots are circles, dashes are capsules three dots long, 1-unit gaps inside a letter (letters sit 3 units apart, set in CSS). */
function Letter({ pattern }: { pattern: string }) {
  const u = 10;
  let x = 0;
  const marks = [...pattern].map((c, i) => {
    const w = c === '-' ? 3 * u : u;
    const el = <rect key={i} x={x} y={0} width={w} height={u} rx={u / 2} />;
    x += w + u;
    return el;
  });
  return (
    <svg className={s.morseLetter} viewBox={`0 0 ${Math.max(u, x - u)} ${u}`} aria-hidden="true">
      {marks}
    </svg>
  );
}

export function MorseCards({ trail, onClose }: { trail: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['hunt', 'cards', trail], queryFn: () => api.get(`/api/hunt/admin/cards?trail=${trail}`, MorseCardSheetSchema) });
  return (
    <div className={ui.stack}>
      <PrintBar onClose={onClose} note="one card per morse stop. stick it on the object. the small print is for organisers; the QR only shows on scan-first stops." />
      <div className={s.cardSheet}>
        {q.data?.cards.map((c) => (
          <div key={c.stopId} className={s.morseCard}>
            <div className={s.morseCode} aria-label={`morse for stop ${c.position}`}>
              {c.patterns.map((p, i) => (
                <Letter key={i} pattern={p} />
              ))}
            </div>
            <div className={s.morseFoot}>
              <RecurseLogo height={16} />
              {c.requireScan && <Qr text={c.url} size={64} label={`QR for ${c.title}`} />}
              <span className={s.morseSmall}>
                #{c.position} {c.title}
                {c.location ? `, ${c.location}` : ''} ({c.code})
              </span>
            </div>
          </div>
        ))}
        {q.data && q.data.cards.length === 0 && <p className={ui.hand}>no morse stops on this trail.</p>}
      </div>
    </div>
  );
}

/*
  KitSheet: the printable sheet of cut-out kit cards (8 per A4 page).
  Each card has a QR that opens the app with the kit ID prefilled
  (APP_URL/?kit=AH-042). The password is printed in text only, never in the QR.
  Rendered in a portal; global print CSS hides everything else (global.css).
*/
import { formatPassword, type GeneratedKit } from '@afterhours/shared';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import logo from '../../assets/brand/recurse-logo-black.png';
import { Button, Doodle, Qr } from '../../kit';
import s from './kitsheet.module.css';

const BANDS = ['var(--tangerine)', 'var(--lime)', 'var(--pink)', 'var(--sky)', 'var(--sun)', 'var(--grape)'];

export function kitUrl(appUrl: string, kitId: string): string {
  return `${appUrl.replace(/\/$/, '')}/?kit=${encodeURIComponent(kitId)}`;
}

function KitCard({ kit, appUrl, i, date }: { kit: GeneratedKit; appUrl: string; i: number; date: string }) {
  const host = appUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <article className={s.card} data-testid="kit-card">
      <div className={s.band} style={{ background: BANDS[i % BANDS.length] }}>
        <span>entry kit</span>
      </div>
      <div className={s.body}>
        <div className={s.top}>
          <img className={s.logo} src={logo} alt="Recurse, KMIT's technical club" />
          <p className={s.event}>after hours, {date}</p>
        </div>
        <p className={s.kitLabel}>your kit</p>
        <p className={s.kitId}>{kit.kitId}</p>
        <div className={s.pw}>
          <span className={s.pwLabel}>password</span>
          <span className={s.pwValue}>{formatPassword(kit.password)}</span>
        </div>
        {kit.name && <p className={s.who}>for {kit.name}</p>}
      </div>
      <div className={s.qrCol}>
        <Qr text={kitUrl(appUrl, kit.kitId)} size={104} label={`QR for ${kit.kitId}`} />
        <p className={s.qrNote}>scan to open the app. your password is not in the code.</p>
        <p className={s.host}>{host}</p>
      </div>
      <Doodle name="scissors" size={18} className={s.scissors} />
    </article>
  );
}

export function KitSheet({ kits, appUrl, eventDate, onClose }: { kits: GeneratedKit[]; appUrl: string; eventDate: string; onClose: () => void }) {
  useEffect(() => {
    document.body.dataset.printing = 'kits';
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      delete document.body.dataset.printing;
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const date = new Date(eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  const pages: GeneratedKit[][] = [];
  for (let i = 0; i < kits.length; i += 8) pages.push(kits.slice(i, i + 8));

  return createPortal(
    <div className={s.overlay} id="print-root" role="dialog" aria-label="Printable kit cards">
      <div className={s.toolbar}>
        <div>
          <h2 className={s.toolTitle}>{kits.length} kit cards</h2>
          <p className={s.toolNote}>A4, 8 per page. Cut on the dashed lines. Hand them out; passwords show only here and in the CSV.</p>
        </div>
        <div className={s.toolBtns}>
          <Button tone="lime" icon="print" onClick={() => window.print()}>
            print
          </Button>
          <Button tone="paper" onClick={onClose}>
            back to console
          </Button>
        </div>
      </div>
      <div className={s.pages}>
        {pages.map((p, pi) => (
          <section key={pi} className={s.page} data-ground="parchment">
            {p.map((k, i) => (
              <KitCard key={k.kitId} kit={k} appUrl={appUrl} i={pi * 8 + i} date={date} />
            ))}
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}

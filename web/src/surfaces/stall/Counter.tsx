/*
  The scan view. A big camera window where the browser can scan QR codes (BarcodeDetector + getUserMedia);
  otherwise, or in addition, the short code typed from the customer's screen. Keeps the screen awake.
*/
import type { Tally } from '@afterhours/shared/features/stalls';
import { useEffect, useRef, useState } from 'react';
import { haptics, sfx } from '../../fun';
import { Button, Doodle } from '../../kit';
import s from './stall.module.css';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let dead = false;
    const grab = async () => {
      try {
        if (!dead && document.visibilityState === 'visible' && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
      } catch {
        /* the screen may dim; scanning still works */
      }
    };
    void grab();
    const vis = () => void grab();
    document.addEventListener('visibilitychange', vis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', vis);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

type Cam = 'starting' | 'on' | 'denied' | 'none';

function Camera({ onCode, paused }: { onCode: (text: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<Cam>(canScan() ? 'starting' : 'none');
  const cb = useRef(onCode);
  const hold = useRef(paused);
  useEffect(() => {
    cb.current = onCode;
    hold.current = paused;
  });

  useEffect(() => {
    if (!canScan()) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ['qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = video.current;
        if (stopped || !v) return;
        v.srcObject = stream;
        await v.play();
        setCam('on');
        let last = 0;
        let lastHit = '';
        let lastAt = 0;
        const loop = async (t: number) => {
          if (stopped) return;
          if (t - last > 160 && v.readyState >= 2 && !hold.current) {
            last = t;
            try {
              const hit = (await detector.detect(v))[0]?.rawValue;
              // The same code in front of the lens must not fire again for a few seconds.
              if (hit && (hit !== lastHit || t - lastAt > 4000)) {
                lastHit = hit;
                lastAt = t;
                sfx.success();
                haptics.success();
                cb.current(hit);
              }
            } catch {
              /* frame not ready */
            }
          }
          raf = requestAnimationFrame((n) => void loop(n));
        };
        raf = requestAnimationFrame((n) => void loop(n));
      } catch {
        if (!stopped) setCam('denied');
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  if (cam === 'none' || cam === 'denied') {
    return (
      <div className={s.noCam}>
        <Doodle name="qr" size={44} fill="var(--sky)" />
        <p>
          {cam === 'denied' ? <b>the camera said no.</b> : <b>this browser can't scan inside the page.</b>} type the code from their screen below, or use your phone's own camera app on their QR: it opens right here.
        </p>
      </div>
    );
  }
  return (
    <div className={s.viewport}>
      <video ref={video} className={s.video} playsInline muted />
      <div className={s.frame} aria-hidden="true" />
      <p className={s.viewHint}>{cam === 'starting' ? 'waking the camera...' : 'point at their QR'}</p>
    </div>
  );
}

export function Counter({ tally, note, busy, onInput }: { tally: Tally; note: string | null; busy: boolean; onInput: (v: string) => void }) {
  const [typed, setTyped] = useState('');
  useWakeLock();
  const go = () => {
    const v = typed.trim();
    if (v.length < 3) return;
    onInput(v);
    setTyped('');
  };
  return (
    <main className={s.counter}>
      <h1 className={s.counterTitle}>scan the next person</h1>
      {note && (
        <p className={s.note} role="alert">
          {note}
        </p>
      )}
      <Camera onCode={onInput} paused={busy} />
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <label className={s.typeLabel} htmlFor="typed-code">
          or type their code
        </label>
        <div className={s.typeWrap}>
          <input id="typed-code" className={s.typeInput} value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={300} placeholder="K7Q M2X" />
          <Button type="submit" tone="lime" size="lg" className={s.typeGo} loading={busy} disabled={typed.trim().length < 3}>
            go
          </Button>
        </div>
      </form>
      {tally.byItem.length > 0 && (
        <section className={s.tally} aria-label="today's hand-overs">
          <h2 className={s.tallyTitle}>today</h2>
          <ul className={s.tallyList}>
            {tally.byItem.map((t) => (
              <li key={t.itemId}>
                <b>{t.qty}</b> {t.name}
              </li>
            ))}
          </ul>
          <p className={s.tallyFine}>
            {tally.txns} people, {tally.freeUnits} free mocktails, {tally.points} points taken
          </p>
        </section>
      )}
    </main>
  );
}

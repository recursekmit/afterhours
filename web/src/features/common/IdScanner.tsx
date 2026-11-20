/*
  Camera scanner for the QR on a college ID card. Used by sign-in (phone) and
  the console's desk mode (laptop). BarcodeDetector where the browser has it,
  the lazy jsQR fallback everywhere else (iPhone Safari, desktop Chrome on
  Windows). Torch button when the camera supports it.
    <IdScanner onCode={(text) => ...} onCancel={...} />
  If the camera is denied or missing it says so kindly and offers `fallback`.
*/
import { useEffect, useRef, useState } from 'react';
import { haptics, sfx } from '../../fun';
import { Button, Doodle } from '../../kit';
import { hasCamera, qrReader } from '../../lib/qr/decodeQr';
import s from './idscanner.module.css';

type Phase = 'starting' | 'scanning' | 'denied' | 'nocamera' | 'broken';

export interface IdScannerProps {
  onCode: (text: string) => void;
  onCancel?: () => void;
  /** Shown when the camera cannot be used: e.g. "type your roll instead". */
  fallbackLabel?: string;
  onFallback?: () => void;
  hint?: string;
  /** Desk laptops use whatever camera they have; phones prefer the back one. */
  facing?: 'environment' | 'user';
  /** Keep scanning after a read (desk mode). */
  continuous?: boolean;
}

export function IdScanner({ onCode, onCancel, fallbackLabel, onFallback, hint = "hold your college ID's QR inside the frame", facing = 'environment', continuous = false }: IdScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>(hasCamera() ? 'starting' : 'nocamera');
  const [torch, setTorch] = useState<{ on: boolean; track: MediaStreamTrack } | null>(null);
  const cb = useRef(onCode);
  useEffect(() => {
    cb.current = onCode;
  });

  useEffect(() => {
    if (!hasCamera()) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let lastHit = '';
    let lastAt = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) return;
        const v = video.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        const track = stream.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        if (track && caps.torch) setTorch({ on: false, track });
        let read;
        try {
          read = await qrReader();
        } catch {
          if (!stopped) setPhase('broken');
          return;
        }
        if (stopped) return;
        setPhase('scanning');
        const loop = async () => {
          if (stopped) return;
          if (v.readyState >= 2) {
            const hit = await read(v).catch(() => null);
            const now = Date.now();
            if (hit && !stopped && (hit !== lastHit || now - lastAt > 3000)) {
              lastHit = hit;
              lastAt = now;
              sfx.success();
              haptics.success();
              cb.current(hit);
              if (!continuous) return;
            }
          }
          timer = window.setTimeout(() => void loop(), 160);
        };
        void loop();
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : '';
        setPhase(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nocamera' : 'broken');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [facing, continuous]);

  const toggleTorch = async () => {
    if (!torch) return;
    const on = !torch.on;
    try {
      await torch.track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ ...torch, on });
    } catch {
      setTorch(null);
    }
  };

  const live = phase === 'starting' || phase === 'scanning';
  return (
    <div className={s.wrap} data-testid="id-scanner" data-phase={phase}>
      {live ? (
        <div className={s.viewport}>
          <video ref={video} className={s.video} playsInline muted />
          <div className={s.frame} aria-hidden="true">
            <span className={s.cornerA} />
            <span className={s.cornerB} />
            <span className={s.cornerC} />
            <span className={s.cornerD} />
            {phase === 'scanning' && <span className={s.sweep} />}
          </div>
          <p className={s.hint} role="status">
            {phase === 'starting' ? 'waking the camera...' : hint}
          </p>
          {torch && (
            <button type="button" className={`${s.torch} ${torch.on ? s.torchOn : ''}`} onClick={() => void toggleTorch()} aria-pressed={torch.on} aria-label="torch">
              <Doodle name="bolt" size={22} />
            </button>
          )}
        </div>
      ) : (
        <div className={s.fallback} role="alert">
          <Doodle name={phase === 'denied' ? 'eye' : 'qr'} size={40} fill={phase === 'denied' ? 'var(--pink)' : 'var(--sky)'} />
          <p>
            {phase === 'denied' ? (
              <>
                <b>the camera said no.</b> that's okay. allow the camera for this site in your browser settings and try again, or skip the camera entirely.
              </>
            ) : phase === 'nocamera' ? (
              <>
                <b>no camera here.</b> no problem, there's another way in.
              </>
            ) : (
              <>
                <b>the camera is acting up.</b> try again, or skip it.
              </>
            )}
          </p>
        </div>
      )}
      <div className={s.actions}>
        {!live && onFallback && fallbackLabel && (
          <Button tone="lime" icon="key" onClick={onFallback}>
            {fallbackLabel}
          </Button>
        )}
        {live && onFallback && fallbackLabel && (
          <Button tone="paper" size="sm" onClick={onFallback}>
            {fallbackLabel}
          </Button>
        )}
        {onCancel && (
          <Button tone="paper" size="sm" ghost onClick={onCancel}>
            back
          </Button>
        )}
      </div>
    </div>
  );
}

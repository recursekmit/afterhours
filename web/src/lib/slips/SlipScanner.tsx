/*
  SlipScanner: full-screen camera reader for Morse slips (docs/SLIPS.md).

    <SlipScanner onScan={(scan, source) => ...} onClose={() => ...} />

  - rear camera (1920 x 1080 ideal: a 176 mm ticket needs the pixels) into the worker pipeline, UI stays smooth
  - cut-paper viewfinder, live outlines of every strip it sees, the bottom one highlighted
  - a guidance line that follows what the camera sees
  - torch toggle where the phone supports it
  - onScan fires once the same bottom reading is seen in `stableFrames` frames in a row
  - "type it instead": a Morse keypad / word box producing the same StripReading shape
  - camera denied or missing: goes straight to the keypad, never a dead end

  SlipScanLauncher is the inline version for a page: a paper card with a button that
  opens the scanner full screen and closes it after a reading.
*/
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SlipScan, StripReading } from '@afterhours/shared/morse-slip';
import { haptics, sfx } from '../../fun';
import { Button, Doodle, IconButton } from '../../kit';
import { MorseKeypad } from './MorseKeypad';
import { type EngineStats, SlipEngine } from './scanner/engine';
import type { FrameResult } from './scanner/pipeline';
import { SlipStabiliser } from './scanner/stabilise';
import s from './slips.module.css';

export type ScanSource = 'camera' | 'typed';

export interface SlipScannerProps {
  /** a stable reading (camera) or a typed one. scan.primary is never null here */
  onScan: (scan: SlipScan, source: ScanSource) => void;
  /** the close button; also called after a reading when after = 'close' */
  onClose?: () => void;
  /** what happens after a reading: show the result card (default), close, or keep scanning */
  after?: 'result' | 'close' | 'continue';
  title?: string;
  /** consecutive identical frames before a reading counts. default 3 */
  stableFrames?: number;
  /** every processed frame (for the dev page) */
  onFrame?: (r: FrameResult, stats: EngineStats) => void;
  /** show the "type it instead" keypad. default true */
  allowTyping?: boolean;
  /** extra content under the result card (e.g. what the reading unlocked) */
  resultExtra?: ReactNode;
}

type Phase = 'starting' | 'live' | 'denied' | 'unsupported';

const GUIDE: Record<FrameResult['status'], string> = {
  none: 'hold it flat, fill the frame',
  far: 'closer. let the slip fill the frame',
  ambiguous: "straighten it up. it's between two edges",
  blank: 'this edge is blank. turn it to read another edge',
  unreadable: 'almost. hold still, a bit more light helps',
  ok: 'got the bottom strip. hold still...',
};

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && (typeof window === 'undefined' || window.isSecureContext !== false);
}

interface TorchTrack {
  getCapabilities?: () => MediaTrackCapabilities;
  applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
}

export function SlipScanner({ onScan, onClose, after = 'result', title = 'scan a slip', stableFrames = 3, onFrame, allowTyping = true, resultExtra }: SlipScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>(cameraAvailable() ? 'starting' : 'unsupported');
  const [frame, setFrame] = useState<FrameResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ scan: SlipScan; source: ScanSource } | null>(null);
  const [typing, setTyping] = useState(!cameraAvailable());
  const [torch, setTorch] = useState<{ track: TorchTrack; on: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const paused = useRef(false);
  const cbs = useRef({ onScan, onClose, onFrame, after });
  useEffect(() => {
    cbs.current = { onScan, onClose, onFrame, after };
  });
  paused.current = Boolean(result) || typing;

  const deliver = useCallback((scan: SlipScan, source: ScanSource) => {
    sfx.success();
    haptics.success();
    const { after: mode, onScan: cb, onClose: close } = cbs.current;
    cb(scan, source);
    if (mode === 'close') close?.();
    else if (mode === 'result') setResult({ scan, source });
    else {
      setFlash(scan.primary?.text ?? scan.primary?.morse ?? '');
      window.setTimeout(() => setFlash(null), 1400);
    }
  }, []);

  // camera + engine
  useEffect(() => {
    if (!cameraAvailable()) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let handle = 0;
    const stab = new SlipStabiliser({ frames: stableFrames });
    let lastStatus = '';
    const engine = new SlipEngine((r, stats) => {
      if (stopped) return;
      cbs.current.onFrame?.(r, stats);
      if (paused.current) return;
      setFrame(r);
      const got = stab.push(r);
      setProgress(stab.progress);
      if (r.status !== lastStatus) {
        if (r.status === 'ok') haptics.tick();
        lastStatus = r.status;
      }
      if (got) deliver(got, 'camera');
    });
    const v = video.current;
    const pump = () => {
      if (stopped || !v) return;
      if (!paused.current) engine.feed(v);
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc) handle = rvfc.call(v, pump);
      else handle = requestAnimationFrame(pump);
    };
    (async () => {
      const mode = engine.init();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch (e) {
        if (stopped) return;
        setPhase((e as DOMException)?.name === 'NotAllowedError' || (e as DOMException)?.name === 'SecurityError' ? 'denied' : 'unsupported');
        setTyping(true);
        return;
      }
      if (stopped || !v) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getVideoTracks()[0] as (MediaStreamTrack & TorchTrack) | undefined;
      try {
        await track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
      } catch {
        /* not every camera can */
      }
      if (track && (track.getCapabilities?.() as { torch?: boolean } | undefined)?.torch) setTorch({ track, on: false });
      v.srcObject = stream;
      v.muted = true;
      v.setAttribute('playsinline', '');
      try {
        await v.play();
      } catch {
        /* autoplay of a muted inline video is allowed; ignore odd refusals */
      }
      await mode;
      if (stopped) return;
      setPhase('live');
      pump();
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(handle);
      const cancel = (v as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null)?.cancelVideoFrameCallback;
      if (cancel && v) cancel.call(v, handle);
      engine.dispose();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stableFrames, deliver]);

  // lock page scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cbs.current.onClose?.();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

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

  const typed = (r: StripReading) => {
    setTyping(false);
    deliver({ primary: r, others: [], at: performance.now() }, 'typed');
  };

  const status = frame?.status ?? 'none';
  const otherCount = frame?.bands.filter((b) => b.side !== 'bottom' && b.reading).length ?? 0;
  const guide = phase === 'starting' ? 'waking the camera...' : GUIDE[status];
  const sub = status === 'ok' && otherCount > 0 ? 'turn it to read another edge' : status === 'none' ? 'the edge nearest the bottom of the screen is the one that counts' : null;
  const camLive = phase === 'starting' || phase === 'live';

  return createPortal(
    <div className={s.scanner} role="dialog" aria-label={title} data-testid="slip-scanner" data-status={status}>
      <video ref={video} className={s.video} playsInline muted aria-hidden="true" />
      {camLive && frame && <Overlay frame={frame} />}
      {camLive && (
        <div className={s.finder} data-hot={status === 'ok' || undefined} aria-hidden="true">
          <span className={`${s.corner} ${s.cTL}`} />
          <span className={`${s.corner} ${s.cTR}`} />
          <span className={`${s.corner} ${s.cBR}`} />
          <span className={`${s.corner} ${s.cBL}`} />
          <span className={s.edgeTape}>this edge gets read</span>
        </div>
      )}
      <header className={s.top}>
        <div className={s.titleChip}>
          <Doodle name="morse" size={22} />
          <h2 className={s.title}>{title}</h2>
        </div>
        <div className={s.topBtns}>
          {torch && <IconButton icon="bolt" label={torch.on ? 'torch off' : 'torch on'} tone={torch.on ? 'sun' : 'paper'} onClick={() => void toggleTorch()} />}
          {onClose && <IconButton icon="close" label="close" onClick={onClose} />}
        </div>
      </header>

      {camLive && !result && !typing && (
        <div className={s.bottom}>
          <div className={s.guide} data-testid="slip-guide" data-status={status}>
            <Dots progress={status === 'ok' ? progress : 0} />
            <div>
              <p className={s.guideLine}>{guide}</p>
              {sub && <p className={s.guideSub}>{sub}</p>}
            </div>
          </div>
          {flash !== null && <p className={s.flash}>read: {flash.toLowerCase()}</p>}
          {allowTyping && (
            <Button tone="paper" size="sm" icon="morse" onClick={() => setTyping(true)}>
              type it instead
            </Button>
          )}
        </div>
      )}

      {typing && !result && (
        <div className={s.typingPanel}>
          {(phase === 'denied' || phase === 'unsupported') && (
            <div className={s.noCam}>
              <Doodle name="eye" size={34} fill="var(--pink)" />
              <p>{phase === 'denied' ? <><b>camera said no.</b> no stress: read the bottom strip yourself and tap it in. (to use the camera, allow it in your browser's site settings.)</> : <><b>no camera here.</b> tap the bottom strip's dots and dashes in, or type the word.</>}</p>
            </div>
          )}
          <MorseKeypad onSubmit={typed} onCancel={camLive ? () => setTyping(false) : undefined} />
        </div>
      )}

      {result && (
        <div className={s.resultPanel}>
          <ResultCard scan={result.scan} source={result.source} />
          {resultExtra}
          <div className={s.resultBtns}>
            <Button
              tone="lime"
              icon="eye"
              onClick={() => {
                setResult(null);
                setFrame(null);
              }}
            >
              scan another
            </Button>
            {onClose && (
              <Button tone="paper" onClick={onClose}>
                done
              </Button>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function Dots({ progress }: { progress: number }) {
  return (
    <span className={s.dots} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i key={i} data-on={progress > i / 3 + 0.01 || undefined} />
      ))}
    </span>
  );
}

/** Strip outlines over the video. The SVG uses the frame's pixel space and the same "cover" crop as the video. */
function Overlay({ frame }: { frame: FrameResult }) {
  const pts = (p: { x: number; y: number }[]) => p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
  const hot = frame.status === 'ok';
  return (
    <svg className={s.overlay} viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {frame.quad && <polygon points={pts(frame.quad)} className={s.ovQuad} data-ambiguous={frame.status === 'ambiguous' || undefined} />}
      {frame.status !== 'ambiguous' &&
        frame.bands.map((b) =>
          b.symbols > 0 || b.side === 'bottom' ? (
            <polygon key={b.side} points={pts(b.poly)} className={b.side === 'bottom' ? (hot ? s.ovBottomHot : s.ovBottom) : s.ovBand} />
          ) : null,
        )}
    </svg>
  );
}

export function MorseInk({ morse, size = 'md' }: { morse: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`${s.ink} ${size === 'sm' ? s.inkSm : ''}`} aria-label={morse}>
      {morse.split(' / ').map((w, wi) => (
        <span key={wi} className={s.inkWord}>
          {w.split(' ').map((l, li) => (
            <span key={li} className={s.inkLetter}>
              {[...l].map((c, ci) => (
                <i key={ci} className={c === '.' ? s.symDot : s.symDash} />
              ))}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export function ResultCard({ scan, source }: { scan: SlipScan; source: ScanSource }) {
  const p = scan.primary;
  if (!p) return null;
  return (
    <div className={s.result} data-testid="slip-result">
      <span className={s.resultTape} aria-hidden="true" />
      <p className={s.resultKicker}>{source === 'camera' ? 'the bottom strip says' : 'you tapped'}</p>
      <p className={s.resultWord} data-testid="slip-result-word">
        {p.text ? p.text.toLowerCase() : 'not a word'}
      </p>
      <MorseInk morse={p.morse} />
      {source === 'camera' && <p className={s.resultMeta}>sure-ness {Math.round(p.confidence * 100)}%</p>}
    </div>
  );
}

/** Inline launcher for pages: a card with a button; opens the full-screen scanner, closes it after one reading. */
export function SlipScanLauncher({ onScan, label = 'scan the slip', hint = 'hold the slip flat, the edge you want at the bottom' }: { onScan: (scan: SlipScan, source: ScanSource) => void; label?: string; hint?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.launcher}>
      <Doodle name="eye" size={34} fill="var(--sky)" />
      <p className={s.launcherHint}>{hint}</p>
      <Button tone="sky" icon="morse" onClick={() => setOpen(true)} data-testid="slip-scan-open">
        {label}
      </Button>
      {open && <SlipScanner after="close" onScan={onScan} onClose={() => setOpen(false)} />}
    </div>
  );
}

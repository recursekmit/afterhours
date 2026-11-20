/*
  Read a QR from a live <video>. Uses the browser's BarcodeDetector where it
  exists (Android Chrome, macOS). Everywhere else (iPhone Safari, Windows and
  Linux Chrome on a desk laptop) it falls back to jsQR, a small pure-JS decoder
  that is lazy-loaded the first time it is needed, so it costs the attendee
  bundle nothing up front.

    const read = await qrReader();
    const text = await read(video); // string | null
*/

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = (new (opts: { formats: string[] }) => Detector) & { getSupportedFormats?: () => Promise<string[]> };

export type QrReader = (video: HTMLVideoElement) => Promise<string | null>;

/** The jsQR path: one frame, downscaled, through jsQR. */
async function jsqrReader(): Promise<QrReader> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('no canvas');
  let tick = 0;
  return async (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    // Alternate between the whole frame and its centre (the on-screen frame), at most ~800 px wide.
    const crop = tick++ % 2 === 1;
    const sx = crop ? vw * 0.15 : 0;
    const sy = crop ? vh * 0.15 : 0;
    const sw = crop ? vw * 0.7 : vw;
    const sh = crop ? vh * 0.7 : vh;
    const scale = Math.min(1, 800 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    const hit = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return hit?.data || null;
  };
}

async function detectorReader(): Promise<QrReader | null> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ['qr_code'];
    if (!formats.includes('qr_code')) return null;
    const detector = new Ctor({ formats: ['qr_code'] });
    return async (video) => {
      try {
        const found = await detector.detect(video);
        return found[0]?.rawValue || null;
      } catch {
        return null; // frame not ready
      }
    };
  } catch {
    return null;
  }
}

/** The best reader this browser has. Rejects only if neither path can run. */
export async function qrReader(): Promise<QrReader> {
  return (await detectorReader()) ?? (await jsqrReader());
}

export function hasCamera(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

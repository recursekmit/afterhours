/*
  Morse slips, web side (docs/SLIPS.md). Import everything from here:
    import { SlipScanner, SlipScanLauncher, SlipSheet, SlipSvg, layoutSlip, type SlipScan } from '../../lib/slips';

  PUBLIC API (stable; the trails screens build on it)

  Components
    <SlipScanner onScan onClose? after? title? stableFrames? onFrame? allowTyping? resultExtra? />
        Full-screen camera reader (portal). onScan(scan: SlipScan, source: 'camera' | 'typed')
        fires once per stable reading; scan.primary is never null in onScan.
        after: 'result' (default) shows a result card + "scan another" | 'close' calls onClose
        right after onScan | 'continue' keeps scanning (dev page).
        onFrame(result: FrameResult, stats: EngineStats) fires for every processed frame.
        Camera denied/missing: shows the Morse keypad, which yields the same SlipScan shape.
    <SlipScanLauncher onScan label? hint? />
        Inline paper card + button that opens SlipScanner (after = 'close'). Drop-in for the
        trails placeholder CameraSlipScanner (same onScan prop).
    <MorseKeypad onSubmit(reading: StripReading) onCancel? />   the typed fallback on its own
    <SlipSvg layout displayWidth? cutLine? />                   one slip, real size by default
    <SlipArt layout />                                          the slip as a bare <g> (mm units)
    <SlipSheet slips: SlipDesign[] title? onClose />            printable A4 sheets with crop marks
    <ResultCard scan source />, <MorseInk morse />              display bits

  Helpers
    designFromPrintItem(item, size?)   GET /api/hunt/admin/slip-print item -> SlipDesign
    readingFromMorse(morse), readingFromWord(word)   -> StripReading (typed readings)
    readingKey(scan)                   what to send: { text?, morse } (docs/SLIPS.md)
    plus everything in shared/src/morse-slip.ts (types, encodeWord, normaliseMorse,
    decodeMorse, reverseReading, layoutSlip, SLIP_SPEC, SLIP_SIZES, schemas)

  Scanner internals (pure TS, also used by the Node tests)
    processFrame(gray, at?, opts?) -> FrameResult, SlipStabiliser, SlipEngine, rgbaToGray
*/
import type { SlipScan } from '@afterhours/shared/morse-slip';

export * from '@afterhours/shared/morse-slip';
export { SlipScanner, SlipScanLauncher, ResultCard, MorseInk, type SlipScannerProps, type ScanSource } from './SlipScanner';
export { MorseKeypad, readingFromMorse, readingFromWord } from './MorseKeypad';
export { SlipSvg, SlipArt, type SlipSvgProps } from './renderSlip';
export { SlipSheet, SlipPage, designFromPrintItem, paginate, type SlipPrintItem, type SlipSheetProps } from './SlipSheet';
export { processFrame, type FrameResult, type FrameStatus, type BandResult, type ScanOptions, type ViewSide } from './scanner/pipeline';
export { SlipStabiliser } from './scanner/stabilise';
export { SlipEngine, type EngineMode, type EngineStats } from './scanner/engine';
export { rgbaToGray, type Gray } from './scanner/image';

/** What the phone sends to the server for a reading: primary.text, else primary.morse (docs/SLIPS.md). */
export function readingKey(scan: SlipScan): { text?: string; morse: string } | null {
  const p = scan.primary;
  if (!p) return null;
  return p.text ? { text: p.text, morse: p.morse } : { morse: p.morse };
}

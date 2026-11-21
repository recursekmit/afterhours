/*
  Slip reading on a trail's slip stop, lazy-loaded (the camera reader is ~30 kB that most phones only
  need at a slip stop). It wraps the shared scanner from web/src/lib/slips (docs/SLIPS.md) and hands
  the trail screen exactly what the server wants: readingKey(scan) = { text?, morse }.
    const SlipReader = lazy(() => import('./slipScanner'));
    <SlipReader onRead={(read, source) => ...} />
*/
import { type ScanSource, SlipScanLauncher, readingKey } from '../../lib/slips';

export default function SlipReader({ onRead }: { onRead: (read: { text?: string; morse: string }, source: ScanSource) => void }) {
  return (
    <SlipScanLauncher
      label="scan the slip"
      hint="hold the card 10-15 cm away with the whole card in view. the edge at the bottom is the one read; turn it to read another."
      onScan={(scan, source) => {
        const read = readingKey(scan);
        if (read) onRead(read, source);
      }}
    />
  );
}

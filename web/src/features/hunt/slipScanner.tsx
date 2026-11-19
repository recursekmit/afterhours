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
      hint="hold the slip flat with the edge you want at the bottom. turn it to read another edge."
      onScan={(scan, source) => {
        const read = readingKey(scan);
        if (read) onRead(read, source);
      }}
    />
  );
}

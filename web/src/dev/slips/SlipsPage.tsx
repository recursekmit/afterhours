/*
  /dev/slips: the bench for Morse slips. Not linked from the app.
  - type a word (or raw Morse) per edge, see the slip and what each way up reads
  - "print test sheet": an A4 of this slip plus a standard test set
  - "open the scanner": live camera, raw FrameResult + every stable SlipScan
  Query params (for e2e and for sharing a setup): ?b=code&r=hi&t=lab&l=sun&n=7&size=card&scan=1&sheet=1
  &after=result (scanner shows the result card), &print=1 (just the slip at real size, for print-to-PNG)
*/
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { celebrate } from '../../fun';
import { Button, Card, DoodleDefs, Scribble, Tabs, TextField, ToastProvider } from '../../kit';
import {
  type EngineStats,
  type FrameResult,
  type ScanSource,
  SLIP_SIZES,
  SLIP_SQUARES,
  SLIP_TICKETS,
  type SlipSquare,
  type SlipTicket,
  type SlipDesign,
  type SlipEdge,
  type SlipScan,
  type SlipSize,
  MorseInk,
  SlipScanner,
  SlipSheet,
  SlipSvg,
  decodeMorse,
  layoutSlip,
  reverseReading,
} from '../../lib/slips';
import s from './slipspage.module.css';

const EDGES: { edge: SlipEdge; key: string; label: string; turn: string }[] = [
  { edge: 'bottom', key: 'b', label: 'bottom', turn: 'as printed' },
  { edge: 'right', key: 'r', label: 'right', turn: 'turn a quarter clockwise' },
  { edge: 'top', key: 't', label: 'top', turn: 'upside down' },
  { edge: 'left', key: 'l', label: 'left', turn: 'turn a quarter anticlockwise' },
];

const TEST_SET: SlipDesign['strips'][] = [
  { bottom: 'code', right: 'hi', top: 'lab', left: 'sun' },
  { bottom: 'stage', right: 'go', top: 'quiz', left: 'map' },
  { bottom: 'recurse', right: 'yes', top: 'decoy', left: 'no' },
  { bottom: 'atrium', left: 'tea' },
  { bottom: '42', right: '7', top: 'kmit', left: 'ok' },
  { bottom: 'net', top: 'net' },
  { bottom: 'e', right: 't', top: 'm', left: 'i' },
];

interface Live {
  frame: FrameResult;
  stats: EngineStats;
}

function Bench() {
  const [params, setParams] = useSearchParams();
  const [words, setWords] = useState<Record<SlipEdge, string>>({
    bottom: params.get('b') ?? 'code',
    right: params.get('r') ?? 'hi',
    top: params.get('t') ?? 'lab',
    left: params.get('l') ?? 'sun',
  });
  const [num, setNum] = useState(params.get('n') ?? '7');
  const [kit, setKit] = useState(params.get('kit') ?? '');
  const size = (params.get('size') as SlipSize | null) ?? 'card';
  // ?ticket=armillary|wave|ginkgo|ruins prints as an engraved ticket; a ticket size without one picks armillary
  const ticketParam = params.get('ticket');
  const ticket: SlipTicket | undefined = SLIP_TICKETS.includes(ticketParam as SlipTicket) ? (ticketParam as SlipTicket) : size === 'ticket' ? 'armillary' : undefined;
  const square = (params.get('square') as SlipSquare | null) ?? 'logo';
  const [scanning, setScanning] = useState(params.get('scan') === '1');
  const [sheet, setSheet] = useState(params.get('sheet') === '1');
  const [live, setLive] = useState<Live | null>(null);
  const [scans, setScans] = useState<{ scan: SlipScan; source: ScanSource }[]>([]);

  const dims = SLIP_SIZES[size] ?? SLIP_SIZES.card;
  const design: SlipDesign = useMemo(
    () => ({
      strips: words,
      number: num.trim() === '' ? undefined : /^\d+$/.test(num) ? Number(num) : num,
      kitId: kit || undefined,
      widthMm: dims.widthMm,
      heightMm: dims.heightMm,
      ticket,
      square,
      qr: square === 'qr' ? `${window.location.origin}/trails` : undefined,
    }),
    [words, num, kit, dims, ticket, square],
  );
  const layout = useMemo(() => layoutSlip(design), [design]);
  const sheetSlips = useMemo<SlipDesign[]>(
    () => [design, { ...design, number: (Number(num) || 0) + 1 }, ...TEST_SET.map((strips, i) => ({ strips, number: 90 + i, widthMm: dims.widthMm, heightMm: dims.heightMm, ticket: ticket ? SLIP_TICKETS[i % SLIP_TICKETS.length] : undefined }))],
    [design, num, dims, ticket],
  );

  const setWord = (edge: SlipEdge, v: string) => {
    setWords((w) => ({ ...w, [edge]: v }));
    const k = EDGES.find((e) => e.edge === edge)!.key;
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const last = scans[0];
  const after = (params.get('after') as 'result' | 'continue' | null) ?? 'continue';
  if (params.get('print') === '1') {
    // bare real-size slip, for print-to-PNG fixtures and the e2e fake camera
    return (
      <div className={s.printOnly} data-testid="slip-print">
        <SlipSvg layout={layout} />
      </div>
    );
  }
  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1 className={s.h1}>slips</h1>
        <Scribble color="var(--lime)" style={{ width: 130 }} />
        <p className={s.note}>morse slips bench. type a word per edge, print it, scan it on a real phone. the edge at the bottom of the camera view is the one that counts.</p>
      </header>

      <div className={s.cols}>
        <Card tone="paper" tilt={-0.6} className={s.editor}>
          <h2 className={s.h2}>the words</h2>
          <Tabs
            value={size}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              next.set('size', v);
              setParams(next, { replace: true });
            }}
            items={(Object.keys(SLIP_SIZES) as SlipSize[]).map((k) => ({ id: k, label: k }))}
            label="slip size"
          />
          <p className={s.note}>{dims.label}</p>
          <Tabs
            value={ticket ?? 'plain'}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              if (v === 'plain') next.delete('ticket');
              else {
                next.set('ticket', v);
                if (size !== 'ticket') next.set('size', 'ticket');
              }
              setParams(next, { replace: true });
            }}
            items={[{ id: 'plain', label: 'plain' }, ...SLIP_TICKETS.map((t) => ({ id: t, label: t }))]}
            label="design"
          />
          {ticket && (
            <Tabs
              value={square}
              onChange={(v) => {
                const next = new URLSearchParams(params);
                next.set('square', v);
                setParams(next, { replace: true });
              }}
              items={SLIP_SQUARES.map((q) => ({ id: q, label: q === 'logo' ? 'recurse mark' : q === 'qr' ? 'small qr' : 'turn-me glyph' }))}
              label="square frame"
            />
          )}
          {EDGES.map(({ edge, label, turn }) => {
            const strip = layout.strips.find((x) => x.edge === edge);
            const err = layout.errors.find((e) => e.startsWith(`${edge}:`));
            const warn = layout.warnings.find((e) => e.startsWith(`${edge}:`));
            return (
              <div key={edge} className={s.edgeRow}>
                <TextField
                  label={`${label} edge (${turn})`}
                  value={words[edge]}
                  onChange={(e) => setWord(edge, e.target.value)}
                  placeholder="blank"
                  autoCapitalize="characters"
                  autoComplete="off"
                  error={err ? err.replace(`${edge}: `, '') : null}
                  hint={strip ? `${strip.units} units, dots ${strip.unitMm.toFixed(1)} mm${warn ? '. long: hold it close' : ''}` : 'blank edge'}
                  data-testid={`edge-${edge}`}
                />
                {strip && <MorseInk morse={strip.morse} size="sm" />}
              </div>
            );
          })}
          <div className={s.row2}>
            <TextField label="slip number" value={num} onChange={(e) => setNum(e.target.value)} inputMode="numeric" />
            <TextField label="kit id (optional)" value={kit} onChange={(e) => setKit(e.target.value)} placeholder="AH-042" />
          </div>
        </Card>

        <div className={s.previewCol}>
          <Card tone="sun" tilt={1} tape className={s.previewCard}>
            <div className={s.slipFrame}>
              <SlipSvg layout={layout} displayWidth="100%" />
            </div>
            <p className={s.realSize}>
              real size {layout.widthMm} x {layout.heightMm} mm
            </p>
          </Card>
          <Card tone="paper" tilt={-0.8} className={s.reads}>
            <h2 className={s.h2}>what it reads</h2>
            <ul className={s.readList}>
              {EDGES.map(({ edge, label, turn }) => {
                const strip = layout.strips.find((x) => x.edge === edge);
                return (
                  <li key={edge}>
                    <b>{label} down</b> <span className={s.turn}>{turn}</span>
                    <span className={s.readVal}>{strip ? (strip.text ?? strip.morse).toLowerCase() : 'nothing there'}</span>
                  </li>
                );
              })}
            </ul>
            <p className={s.note}>
              upside-down secrets: read naively, the top strip comes out as{' '}
              {(() => {
                const top = layout.strips.find((x) => x.edge === 'top');
                if (!top) return 'nothing';
                const rev = reverseReading(top.morse);
                return <b>{decodeMorse(rev)?.toLowerCase() ?? rev}</b>;
              })()}
              . plant that as a decoy reading if you like.
            </p>
          </Card>
          <div className={s.actions}>
            <Button tone="lime" size="lg" icon="eye" onClick={() => setScanning(true)} data-testid="open-scanner">
              open the scanner
            </Button>
            <Button tone="pink" icon="print" onClick={() => setSheet(true)} data-testid="print-sheet">
              print test sheet
            </Button>
          </div>
        </div>
      </div>

      <Card tone="paper" className={s.logCard}>
        <h2 className={s.h2}>scans</h2>
        {scans.length === 0 ? (
          <p className={s.note}>nothing scanned yet. open the scanner and hold a printed slip in view.</p>
        ) : (
          <ol className={s.log}>
            {scans.slice(0, 12).map((x, i) => (
              <li key={scans.length - i}>
                <b>{x.scan.primary?.text?.toLowerCase() ?? x.scan.primary?.morse}</b> <span className={s.turn}>{x.source}, {Math.round((x.scan.primary?.confidence ?? 0) * 100)}%</span>
              </li>
            ))}
          </ol>
        )}
        {last && <pre className={s.pre} data-testid="dev-last-scan">{JSON.stringify(last.scan, null, 1)}</pre>}
      </Card>

      {scanning && (
        <>
          <SlipScanner
            title="slip bench"
            after={after}
            stableFrames={Number(params.get('stable')) || 3}
            onClose={() => setScanning(false)}
            onFrame={(frame, stats) => setLive({ frame, stats })}
            onScan={(scan, source) => {
              setScans((v) => [{ scan, source }, ...v]);
              if (source === 'typed') celebrate();
            }}
          />
          <div className={s.debug} data-testid="dev-live" data-status={live?.frame.status ?? 'none'}>
            <p>
              <b>{live?.frame.status ?? 'waiting'}</b> {live ? `${live.stats.fps} fps, ${live.stats.ms} ms, ${live.stats.mode}, ${live.stats.width}x${live.stats.height}, tilt ${live.frame.tiltDeg ?? '-'}` : ''}
            </p>
            {live?.frame.bands.map((b) => (
              <p key={b.side}>
                {b.side}: {b.reading ? `${b.reading.text?.toLowerCase() ?? '?'} ${b.reading.morse} (${Math.round(b.reading.confidence * 100)}%)` : b.symbols ? `${b.symbols} blobs` : '-'}
              </p>
            ))}
            {last && (
              <p className={s.debugLast} data-testid="dev-last-primary">
                last scan: {last.scan.primary?.text?.toLowerCase() ?? last.scan.primary?.morse}
              </p>
            )}
          </div>
        </>
      )}
      {sheet && <SlipSheet slips={sheetSlips} title="test sheet" onClose={() => setSheet(false)} />}
    </div>
  );
}

export default function SlipsPage() {
  return (
    <ToastProvider>
      <DoodleDefs />
      <Bench />
    </ToastProvider>
  );
}

/*
  Console: slip sets for a trail (docs/SLIPS.md). A set is shared (same slips in every kit) or
  per-kit (words drawn from a pool per kit). Each slip has up to four edge readings (the edge at
  the bottom when read) plus extra decoy sequences, each with an outcome. Live counts per reading.
  Exports what the slip printer needs (per kit for per-kit sets).
*/
import {
  type HuntAdminStop,
  SLIP_ORIENTATIONS,
  SLIP_OUTCOMES,
  type SlipOrientation,
  type SlipOutcome,
  SlipPrintSheetSchema,
  type SlipReadingAdmin,
  type SlipReadingInput,
  SlipSetListSchema,
  type SlipSetMode,
  type TrailAdminList,
  slipWordKey,
} from '@afterhours/shared/features/hunt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KIT_SLIP_SIZE, type PrintAs, SLIP_SIZES, SLIP_TICKETS, type SlipDesign, SlipSheet, TICKET_ART, designFromPrintItem, edgeCapacity, encodeWord } from '../../lib/slips';
import { api } from '../../core/api';
import { Button, IconButton, Sheet, TextField, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import s from './hunt.module.css';

interface Row {
  orientation: SlipOrientation;
  word: string;
  morse: string;
  outcome: SlipOutcome;
  targetStopId: number | null;
  targetTrailId: number | null;
  clue: string;
  bonusPoints: number;
  message: string;
}
const rowOf = (r: SlipReadingAdmin): Row => ({
  orientation: r.orientation,
  word: r.word ?? '',
  morse: r.word ? '' : (r.morse ?? ''),
  outcome: r.outcome,
  targetStopId: r.targetStopId,
  targetTrailId: r.targetTrailId,
  clue: r.clue,
  bonusPoints: r.bonusPoints,
  message: r.message,
});
const blankRow = (orientation: SlipOrientation): Row => ({ orientation, word: '', morse: '', outcome: 'next', targetStopId: null, targetTrailId: null, clue: '', bonusPoints: 5, message: '' });

/**
 * A word too long for its edge cannot be printed at the minimum dot size: say so, with the edge's
 * capacity in Morse units (dot 1, dash 3, gaps 1/3/7), the same rule the slip renderer applies.
 */
export function edgeFit(orientation: SlipOrientation, word: string | null): { units: number; capacity: number } | null {
  if (!word || orientation === 'extra') return null;
  try {
    const units = encodeWord(word).units;
    // kit slips print as tickets (176 x 80) by default
    const capacity = edgeCapacity(orientation, SLIP_SIZES[KIT_SLIP_SIZE].widthMm, SLIP_SIZES[KIT_SLIP_SIZE].heightMm);
    return units > capacity ? { units, capacity } : null;
  } catch {
    return null;
  }
}

function TooLong({ orientation, word }: { orientation: SlipOrientation; word: string | null }) {
  const fit = edgeFit(orientation, word);
  if (!fit) return null;
  return (
    <span className={s.tooLong} role="note">
      too long for the {orientation} edge: {fit.units} units, fits {fit.capacity}. use a shorter word.
    </span>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function SlipForm({ setId, mode, slip, stops, trails, onDone }: { setId: number; mode: SlipSetMode; slip: { id: number; slipNo: number; label: string; readings: SlipReadingAdmin[] } | null; stops: HuntAdminStop[]; trails: TrailAdminList['trails']; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [slipNo, setSlipNo] = useState(slip?.slipNo ?? 1);
  const [label, setLabel] = useState(slip?.label ?? '');
  const [rows, setRows] = useState<Row[]>(slip ? slip.readings.map(rowOf) : [blankRow('bottom')]);
  const set = (i: number, r: Partial<Row>) => setRows((l) => l.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const save = useMutation({
    mutationFn: () => {
      const readings: SlipReadingInput[] = rows.map((r) => ({
        orientation: r.orientation,
        word: r.word.trim() ? r.word.trim() : null,
        morse: r.morse.trim() ? r.morse.trim() : null,
        outcome: r.outcome,
        targetStopId: r.outcome === 'next' || r.outcome === 'branch' ? r.targetStopId : null,
        targetTrailId: r.outcome === 'branch' ? r.targetTrailId : null,
        clue: r.clue,
        bonusPoints: r.bonusPoints,
        message: r.message,
      }));
      const body = { slipNo, label, readings };
      return slip ? api.put(`/api/hunt/admin/slips/${slip.id}`, body, SlipSetListSchema) : api.post(`/api/hunt/admin/slip-sets/${setId}/slips`, body, SlipSetListSchema);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hunt'] });
      onDone();
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <div className={ui.stack}>
      <div className={ui.row}>
        <TextField label="slip number" type="number" min={1} max={99} value={slipNo} onChange={(e) => setSlipNo(Number(e.target.value))} />
        <TextField label="label (small print)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {rows.map((r, i) => (
        <div key={i} className={s.readingRow}>
          <label className={ui.label}>
            edge
            <select className={ui.select} value={r.orientation} onChange={(e) => set(i, { orientation: e.target.value as SlipOrientation })}>
              {SLIP_ORIENTATIONS.map((o) => (
                <option key={o} value={o}>
                  {o === 'extra' ? 'extra (decoy sequence)' : `${o} edge`}
                </option>
              ))}
            </select>
          </label>
          {r.orientation === 'extra' ? (
            <TextField label="sequence, e.g. -.-. ---" value={r.morse} onChange={(e) => set(i, { morse: e.target.value })} />
          ) : (
            <TextField label={mode === 'per_kit' ? 'word (empty: drawn per kit)' : 'word'} value={r.word} onChange={(e) => set(i, { word: e.target.value.toUpperCase() })} />
          )}
          <label className={ui.label}>
            outcome
            <select className={ui.select} value={r.outcome} onChange={(e) => set(i, { outcome: e.target.value as SlipOutcome })}>
              {SLIP_OUTCOMES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          {(r.outcome === 'next' || r.outcome === 'branch') && (
            <label className={ui.label}>
              to stop
              <select className={ui.select} value={r.targetStopId ?? ''} onChange={(e) => set(i, { targetStopId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{r.outcome === 'next' ? 'the next in order' : 'none (a trail instead)'}</option>
                {stops.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.position}. {st.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {r.outcome === 'branch' && r.targetStopId === null && (
            <label className={ui.label}>
              or unlock trail
              <select className={ui.select} value={r.targetTrailId ?? ''} onChange={(e) => set(i, { targetTrailId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">pick a trail</option>
                {trails.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {r.outcome === 'clue' && <TextField label="clue text" value={r.clue} maxLength={300} onChange={(e) => set(i, { clue: e.target.value })} />}
          {r.outcome === 'bonus' && <TextField label="bonus points" type="number" min={0} max={50} value={r.bonusPoints} onChange={(e) => set(i, { bonusPoints: Number(e.target.value) })} />}
          <TextField label="message (optional)" value={r.message} maxLength={200} onChange={(e) => set(i, { message: e.target.value })} />
          <span className={s.readingMorse}>{r.word ? slipWordKey(r.word) : r.morse}</span>
          <TooLong orientation={r.orientation} word={r.word.trim() || null} />
          <IconButton size="sm" icon="close" label="remove reading" onClick={() => setRows((l) => l.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div className={ui.row}>
        {rows.length < 8 && (
          <Button size="sm" tone="paper" icon="plus" onClick={() => setRows((l) => [...l, blankRow((['bottom', 'right', 'top', 'left'] as const).find((o) => !l.some((x) => x.orientation === o)) ?? 'extra')])}>
            add a reading
          </Button>
        )}
        <Button tone="lime" icon="check" onClick={() => save.mutate()} loading={save.isPending}>
          save slip
        </Button>
        <Button tone="paper" ghost onClick={onDone}>
          cancel
        </Button>
      </div>
    </div>
  );
}

export function SlipEditor({ trail, stops, trails }: { trail: number; stops: HuntAdminStop[]; trails: TrailAdminList['trails'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sets = useQuery({ queryKey: ['hunt', 'slips', trail], queryFn: () => api.get(`/api/hunt/admin/slip-sets?trail=${trail}`, SlipSetListSchema), refetchInterval: 6000 });
  const [title, setTitle] = useState('kit slips');
  const [mode, setMode] = useState<SlipSetMode>('shared');
  const [pool, setPool] = useState('');
  const [edit, setEdit] = useState<{ setId: number; mode: SlipSetMode; slip: Parameters<typeof SlipForm>[0]['slip'] } | null>(null);
  const [printing, setPrinting] = useState<{ title: string; slips: SlipDesign[] } | null>(null);
  const [printAs, setPrintAs] = useState<PrintAs>('mixed');
  const printSet = async (setId: number) => {
    try {
      const sheet = await api.get(`/api/hunt/admin/slip-print?set=${setId}`, SlipPrintSheetSchema);
      setPrinting({ title: sheet.mode === 'per_kit' ? `${sheet.title} (one per kit)` : sheet.title, slips: sheet.slips.map((i) => designFromPrintItem(i, undefined, printAs)) });
    } catch (e) {
      toast((e as Error).message, { kind: 'bad' });
    }
  };
  const create = useMutation({
    mutationFn: () => api.post(`/api/hunt/admin/slip-sets?trail=${trail}`, { title, mode, pool: pool.split(/[\s,]+/).filter(Boolean) }, SlipSetListSchema),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hunt', 'slips', trail] }),
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const exportSet = async (setId: number, kind: 'json' | 'csv') => {
    const sheet = await api.get(`/api/hunt/admin/slip-print?set=${setId}`, SlipPrintSheetSchema);
    if (kind === 'json') return download(`slips-${setId}.json`, JSON.stringify(sheet, null, 2), 'application/json');
    const lines = ['kit_id,slip_no,label,bottom,right,top,left'];
    for (const sl of sheet.slips) lines.push([sl.kitId ?? '', sl.slipNo, sl.label, sl.edges.bottom?.word ?? '', sl.edges.right?.word ?? '', sl.edges.top?.word ?? '', sl.edges.left?.word ?? ''].join(','));
    download(`slips-${setId}.csv`, lines.join('\n'), 'text/csv');
  };
  return (
    <Section title="slips" tilt={-0.2}>
      <p className={ui.hand}>the edge at the bottom of the camera view is the one read. each edge can send people somewhere different. unknown readings always get the same "try turning it" reply.</p>
      <label className={ui.label}>
        print slips as
        <select className={ui.select} value={printAs} onChange={(e) => setPrintAs(e.target.value as PrintAs)} data-testid="slip-print-as">
          <option value="mixed">tickets, all four designs in turn (176 x 80)</option>
          {SLIP_TICKETS.map((t) => (
            <option key={t} value={t}>
              ticket: {TICKET_ART[t].label}
            </option>
          ))}
          <option value="card">plain card, black on white (85 x 55)</option>
        </select>
      </label>
      {sets.data?.sets.map((st) => (
        <div key={st.id} className={s.slipSet}>
          <div className={ui.between}>
            <span>
              <b>{st.title}</b> <Stamp tone={st.mode === 'per_kit' ? 'late' : 'sky'}>{st.mode === 'per_kit' ? 'per kit' : 'shared'}</Stamp>
              {st.mode === 'per_kit' && <span className={ui.hand}> pool: {st.pool.length} words</span>}
            </span>
            <span className={ui.row}>
              <Button size="sm" tone="sun" icon="print" onClick={() => void printSet(st.id)} data-testid={`print-slips-${st.id}`}>
                print slips
              </Button>
              <Button size="sm" tone="paper" icon="download" onClick={() => void exportSet(st.id, 'csv')}>
                printer csv
              </Button>
              <Button size="sm" tone="paper" icon="download" onClick={() => void exportSet(st.id, 'json')}>
                json
              </Button>
              <Button size="sm" tone="lime" icon="plus" onClick={() => setEdit({ setId: st.id, mode: st.mode, slip: null })}>
                slip
              </Button>
            </span>
          </div>
          {st.slips.map((sl) => (
            <div key={sl.id} className={s.slipCardAdmin}>
              <div className={ui.between}>
                <b>
                  slip {sl.slipNo} {sl.label}
                </b>
                <Button size="sm" tone="paper" onClick={() => setEdit({ setId: st.id, mode: st.mode, slip: sl })}>
                  edit
                </Button>
              </div>
              <table className={ui.table}>
                <tbody>
                  {sl.readings.map((r) => (
                    <tr key={r.id}>
                      <td>{r.orientation}</td>
                      <td className={ui.num}>
                        {r.word ?? (r.morse ? r.morse : 'per kit')} <TooLong orientation={r.orientation} word={r.word} />
                      </td>
                      <td>
                        <Stamp tone={r.outcome === 'decoy' ? 'done' : r.outcome === 'bonus' ? 'info' : 'sky'}>{r.outcome}</Stamp> {r.targetStopId ? stops.find((x) => x.id === r.targetStopId)?.title : r.targetTrailId ? `trail #${r.targetTrailId}` : r.clue}
                      </td>
                      <td>
                        <b>{r.finds}</b> found it
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
      <div className={s.slipSet}>
        <b>new slip set</b>
        <div className={ui.row}>
          <TextField label="name" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
          <label className={ui.label}>
            kind
            <select className={ui.select} value={mode} onChange={(e) => setMode(e.target.value as SlipSetMode)}>
              <option value="shared">shared: same slips in every kit</option>
              <option value="per_kit">per kit: words drawn from a pool</option>
            </select>
          </label>
          {mode === 'per_kit' && <TextField label="word pool (spaces or commas)" value={pool} onChange={(e) => setPool(e.target.value.toUpperCase())} />}
          <Button tone="lime" icon="plus" onClick={() => create.mutate()} disabled={!title.trim()}>
            create set
          </Button>
        </div>
      </div>
      {printing && <SlipSheet slips={printing.slips} title={printing.title} onClose={() => setPrinting(null)} />}
      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit?.slip ? `slip ${edit.slip.slipNo}` : 'new slip'}>
        {edit && <SlipForm setId={edit.setId} mode={edit.mode} slip={edit.slip} stops={stops} trails={trails} onDone={() => setEdit(null)} />}
      </Sheet>
    </Section>
  );
}

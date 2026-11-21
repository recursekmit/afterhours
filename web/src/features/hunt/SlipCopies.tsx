/*
  Console: the printed copies of a unique slip set (docs/SLIPS.md, "unique slips").
  - how many copies (default 80): grow any time; shrink only past unclaimed serials; draw every word
    again only while nothing is claimed (and before printing!)
  - a warning when fewer copies than people signed in
  - the copies table: serial, and per slip who claimed that copy and when, with "release" for a lost
    slip or a mistake
  - the private answer key (serial -> words) as CSV
*/
import { type SlipCopies, SlipCopiesSchema, UNIQUE_SLIP_MAX_COPIES } from '@afterhours/shared/features/hunt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../core/api';
import { Button, TextField, useToast } from '../../kit';
import { TICKET_ART } from '../../lib/slips';
import { Stamp, downloadHref, ui } from '../common/ui';
import s from './hunt.module.css';

const pad = (n: number) => String(n).padStart(3, '0');
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function SlipCopiesPanel({ setId, onPrint }: { setId: number; onPrint: (range: { from: number; to: number }) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['hunt', 'copies', setId], queryFn: () => api.get(`/api/hunt/admin/slip-sets/${setId}/copies`, SlipCopiesSchema), refetchInterval: 5000 });
  const [n, setN] = useState<number | null>(null);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState<number | null>(null);
  const [find, setFind] = useState('');
  const [onlyClaimed, setOnlyClaimed] = useState(false);
  const done = (d: SlipCopies) => {
    qc.setQueryData(['hunt', 'copies', setId], d);
    void qc.invalidateQueries({ queryKey: ['hunt', 'slips'] });
  };
  const resize = useMutation({
    mutationFn: (body: { copies: number; regenerate?: boolean }) => api.post(`/api/hunt/admin/slip-sets/${setId}/copies`, body, SlipCopiesSchema),
    onSuccess: (d) => {
      done(d);
      setN(null);
      toast(`${d.copies} copies of every slip`, { kind: 'good' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  // Releases the whole set (every slip of that serial), e.g. a lost kit or a friend who scanned someone else's.
  const release = useMutation({
    mutationFn: (v: { copyId: number; serial: number }) => api.post(`/api/hunt/admin/slip-copies/${v.copyId}/release`, undefined, SlipCopiesSchema),
    onSuccess: (d, v) => {
      done(d);
      toast(`set no. ${pad(v.serial)} released`, { kind: 'good' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const rows = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    const f = find.trim().toLowerCase();
    return d.rows.filter((r) => {
      if (onlyClaimed && !r.cells.some((c) => c.claimedBy)) return false;
      if (!f) return true;
      return pad(r.serial).includes(f.replace(/^no\.?\s*/, '')) || r.cells.some((c) => c.claimedBy?.nickname?.toLowerCase().includes(f));
    });
  }, [q.data, find, onlyClaimed]);
  const d = q.data;
  if (!d) return <p className={ui.hand}>loading copies...</p>;
  const want = n ?? d.copies;
  const last = to ?? d.copies;
  const short = d.signedIn > d.copies;
  return (
    <div className={s.copies} data-testid={`slip-copies-${setId}`}>
      <div className={ui.row}>
        <TextField label="printed copies of every slip" type="number" min={1} max={UNIQUE_SLIP_MAX_COPIES} value={want} onChange={(e) => setN(Number(e.target.value))} />
        <Button size="sm" tone="lime" icon="check" disabled={want === d.copies || want < 1} loading={resize.isPending} onClick={() => resize.mutate({ copies: want })}>
          {want > d.copies ? `add ${want - d.copies} copies` : want < d.copies ? `drop to ${want}` : 'copies set'}
        </Button>
        <Button
          size="sm"
          tone="paper"
          ghost
          icon="undo"
          disabled={d.claimed > 0}
          onClick={() => {
            if (window.confirm('Draw new words for EVERY copy? Anything already printed stops working. Only do this before printing.')) resize.mutate({ copies: d.copies, regenerate: true });
          }}
        >
          new words for all
        </Button>
      </div>
      {short && (
        <p className={s.banner} role="alert">
          {d.signedIn} people have signed in but only {d.copies} copies are printed. add more copies (and print them), or some people will have no slip.
        </p>
      )}
      <div className={ui.row}>
        <TextField label="print from no." type="number" min={1} max={d.copies} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
        <TextField label="to no." type="number" min={1} max={d.copies} value={last} onChange={(e) => setTo(Number(e.target.value))} />
        <Button size="sm" tone="sun" icon="print" onClick={() => onPrint({ from: Math.max(1, from), to: Math.min(d.copies, last) })} data-testid={`print-copies-${setId}`}>
          print {from === 1 && last === d.copies ? 'the whole set' : `no. ${pad(from)} to ${pad(last)}`}
        </Button>
        <Button size="sm" tone="paper" icon="download" onClick={() => downloadHref(`/api/hunt/admin/slip-sets/${setId}/answer-key.csv`)}>
          answer key csv
        </Button>
        <span className={ui.hand}>the answer key is private: it has every word on every copy.</span>
      </div>
      <div className={ui.between}>
        <span>
          <b className={ui.num}>{d.claimed}</b> of {d.copies * d.slips.length} copies claimed, <b className={ui.num}>{d.signedIn}</b> signed in
        </span>
        <span className={ui.row}>
          <TextField label="find no. or nickname" value={find} onChange={(e) => setFind(e.target.value)} />
          <label className={ui.toggle}>
            <input type="checkbox" checked={onlyClaimed} onChange={(e) => setOnlyClaimed(e.target.checked)} />
            claimed only
          </label>
        </span>
      </div>
      <div className={s.copiesScroll}>
        <table className={ui.table} data-testid="copies-table">
          <thead>
            <tr>
              <th>no.</th>
              {d.slips.map((sl) => (
                <th key={sl.id}>
                  slip {sl.slipNo} {sl.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.serial}>
                <td className={ui.num}>{pad(r.serial)}</td>
                {r.cells.map((c) => (
                  <td key={c.copyId}>
                    {c.design && (
                      // the ticket's own ground colour (the art), so the table reads like the stack of tickets
                      <span className={s.copyDesign} data-design={c.design} style={{ background: TICKET_ART[c.design].ground }}>
                        {c.design}
                      </span>
                    )}
                    {c.claimedBy ? (
                      <span className={s.copyCell}>
                        <b>{c.claimedBy.nickname ?? `#${c.claimedBy.attendeeId}`}</b>
                        {c.claimedAt !== null && <span className={ui.hand}>{time(c.claimedAt)}</span>}
                        <Button
                          size="sm"
                          tone="paper"
                          ghost
                          loading={release.isPending && release.variables?.serial === r.serial}
                          onClick={() => {
                            if (window.confirm(`Release set no. ${pad(r.serial)}? Every slip of that set is freed, and whoever played on it starts over.`)) release.mutate({ copyId: c.copyId, serial: r.serial });
                          }}
                        >
                          release set
                        </Button>
                      </span>
                    ) : (
                      <Stamp tone="ink" rot={0}>
                        free
                      </Stamp>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className={ui.hand}>no copies match.</p>}
      </div>
    </div>
  );
}

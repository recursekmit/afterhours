/* Console: freeze, reveal (ranks topN..1 on the server clock), unfreeze, and an admin peek at the real board. */
import { FreezeStateSchema } from '@afterhours/shared/features/leaderboard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { Button, TextField, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import { Row } from './Attendee';
import { HereConsole } from './Here';
import s from './leaderboard.module.css';
import { useBoard } from './useBoard';

export default function LeaderboardConsole() {
  const qc = useQueryClient();
  const toast = useToast();
  const board = useBoard(10);
  const peek = useBoard(15, true);
  const [topN, setTopN] = useState(10);
  const [stepS, setStepS] = useState(5);
  const [suspenseS, setSuspenseS] = useState(4);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.post(`/api/leaderboard/admin/${path}`, body, FreezeStateSchema),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['leaderboard', 'board'] }),
    onError: (e) => toast(e.message, { kind: 'bad', title: 'nope' }),
  });
  const f = board.data?.freeze;
  const reveal = f?.reveal;
  return (
    <div className={ui.stack}>
      <HereConsole />
      <Section title="the big reveal" tape action={f && <Stamp tone={f.frozen ? 'sky' : 'live'}>{f.frozen ? 'frozen' : 'live'}</Stamp>}>
        <p className={ui.hand}>
          1. freeze before the wrap: everyone sees the top places as ???, their own points keep counting. 2. start the reveal: places uncover from #{topN} to #1 on every screen at once, with a drum roll before #1. 3. unfreeze afterwards.
        </p>
        <div className={ui.row}>
          <TextField label="places to reveal" type="number" min={1} max={50} value={topN} onChange={(e) => setTopN(Number(e.target.value))} />
          <TextField label="seconds between places" type="number" min={1} max={30} value={stepS} onChange={(e) => setStepS(Number(e.target.value))} />
          <TextField label="extra drum roll before #1 (s)" type="number" min={0} max={30} value={suspenseS} onChange={(e) => setSuspenseS(Number(e.target.value))} />
        </div>
        <div className={ui.row}>
          <Button tone="sky" icon="lock" onClick={() => act.mutate({ path: 'freeze', body: { topN, stepMs: stepS * 1000, suspenseMs: suspenseS * 1000, hideTop: true } })}>
            {f?.frozen ? 'freeze again (fresh snapshot)' : 'freeze the board'}
          </Button>
          <Button tone="sun" icon="trophy" disabled={!f?.frozen} onClick={() => act.mutate({ path: 'reveal', body: { restart: Boolean(reveal?.startedAt) } })}>
            {reveal?.startedAt ? 'restart the reveal' : 'start the reveal'}
          </Button>
          <Button tone="lime" icon="undo" disabled={!f?.frozen} onClick={() => act.mutate({ path: 'unfreeze', body: {} })}>
            unfreeze
          </Button>
        </div>
        {reveal?.startedAt && (
          <p className={ui.handBig}>
            revealed {reveal.revealed} of {reveal.topN}
            {reveal.done ? ', done!' : '...'}
          </p>
        )}
      </Section>
      <Section title="admin peek (the real order)" tilt={0.3}>
        <ol className={s.list}>
          {peek.data?.rows.map((r) => (
            <Row key={r.hidden ? `h${r.rank}` : r.attendeeId} r={r} />
          ))}
        </ol>
      </Section>
    </div>
  );
}

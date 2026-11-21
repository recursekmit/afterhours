/*
  "Still here?" (event day): prizes go to the top people who are still in the room. Attendees tap "I'm here"
  once; the console ranks only the people who tapped, in live leaderboard order.
*/
import { HereBoardSchema, HereMeSchema } from '@afterhours/shared/features/leaderboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import s from './leaderboard.module.css';

const hereKey = ['leaderboard', 'here', 'me'] as const;

/** Home screen and the board page: one big button. */
export function HereCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: hereKey, queryFn: () => api.get('/api/leaderboard/here', HereMeSchema), staleTime: 60_000 });
  const tap = useMutation({
    mutationFn: () => api.post('/api/leaderboard/here', {}, HereMeSchema),
    onSuccess: (d) => {
      qc.setQueryData(hereKey, d);
      celebrate({ y: 0.4 });
      sfx.success();
      haptics.success();
    },
  });
  if (!q.data) return null;
  const here = q.data.here;
  return (
    <Card tone={here ? 'paper' : 'sun'} tilt={here ? 0.4 : -1.2} tape="left" tapeColor="pink" data-testid="here-card">
      <span className={ui.kicker}>prizes for the top two</span>
      <h3 className={ui.cardTitle}>{here ? "you're marked as here" : 'still here? tap to claim your spot'}</h3>
      <p className={ui.hand}>
        {here
          ? 'stay in the room. prizes go to the top two on the board who are still here.'
          : 'prizes go to the top two on the board who are still in the room. tap so we know you are here.'}
      </p>
      {!here && (
        <Button tone="lime" size="lg" block icon="check" loading={tap.isPending} onClick={() => tap.mutate()} data-testid="here-tap">
          I&apos;m here
        </Button>
      )}
      {tap.isError && <p role="alert">{tap.error.message}</p>}
    </Card>
  );
}

/** Console: the board, only people who tapped "I'm here". */
export function HereConsole() {
  const qc = useQueryClient();
  const toast = useToast();
  const [sure, setSure] = useState(false);
  const q = useQuery({ queryKey: ['leaderboard', 'here', 'admin'], queryFn: () => api.get('/api/leaderboard/admin/here', HereBoardSchema), refetchInterval: 5_000 });
  useLiveEvent('leaderboard.here', () => void qc.invalidateQueries({ queryKey: ['leaderboard', 'here', 'admin'] }));
  const clear = useMutation({
    mutationFn: () => api.post('/api/leaderboard/admin/here/clear', { confirm: 'CLEAR' }, HereBoardSchema),
    onSuccess: () => {
      setSure(false);
      void qc.invalidateQueries({ queryKey: ['leaderboard', 'here'] });
    },
    onError: (e) => toast(e.message, { kind: 'bad', title: 'nope' }),
  });
  const d = q.data;
  return (
    <Section title="who is still here (prize board)" tape action={d && <Stamp tone="live">{d.here} here</Stamp>}>
      <p className={ui.hand}>
        everyone has an &quot;I&apos;m here&quot; button on their home screen and the board page. this list is the live board, only people who tapped it. #1 and #2 here get the prizes. the small number is their rank on the full board.
      </p>
      <ol className={s.list} data-testid="here-board">
        {d?.rows.map((r) => (
          <li key={r.attendeeId} className={`${s.row} ${r.place <= 2 ? s[`top${r.place}`] : ''}`}>
            <span className={s.rank}>#{r.place}</span>
            <span>
              <strong>{r.nickname}</strong> {r.roll ? <small>{r.roll}</small> : null} <small>(board #{r.rank})</small>
            </span>
            <span>{r.total} pts</span>
          </li>
        ))}
        {d && d.rows.length === 0 && <p className={ui.hand}>nobody has tapped yet.</p>}
      </ol>
      <div className={ui.row}>
        <Button tone="paper" size="sm" icon="undo" onClick={() => (sure ? clear.mutate() : setSure(true))}>
          {sure ? 'tap again: clear everyone' : 'clear the list (start over)'}
        </Button>
      </div>
    </Section>
  );
}

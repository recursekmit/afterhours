/* Console: arcade on/off and per-game switches, run stats, typed-confirm reset. */
import { OkSchema } from '@afterhours/shared';
import { ARCADE_GAMES, ArcadeSettingsSchema, ArcadeStatsSchema, type GameId } from '@afterhours/shared/features/arcade';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { Button, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, ui } from '../common/ui';
import { RoundsConsole } from './rounds/Console';

const CONFIRM = 'RESET ARCADE';

export default function ArcadeConsole() {
  const toast = useToast();
  const stats = useQuery({ queryKey: ['arcade', 'stats'], queryFn: () => api.get('/api/arcade/admin/stats', ArcadeStatsSchema), refetchInterval: 5000 });
  useLiveEvent('arcade.toggled', () => void stats.refetch());
  const [confirm, setConfirm] = useState('');
  const opts = { onSuccess: () => void stats.refetch(), onError: (e: Error) => toast(e.message, { kind: 'bad' }) };
  const set = useMutation({ mutationFn: (body: { enabled?: boolean; games?: Partial<Record<GameId, boolean>> }) => api.post('/api/arcade/admin/settings', body, ArcadeSettingsSchema), ...opts });
  const reset = useMutation({ mutationFn: () => api.post('/api/arcade/admin/reset', { confirm: CONFIRM }, OkSchema), ...opts });
  const st = stats.data;
  return (
    <div className={ui.stack}>
      <RoundsConsole />
      <Section title="arcade" tape action={st && <Stamp tone={st.settings.enabled ? 'live' : 'done'}>{st.settings.enabled ? 'open' : 'closed'}</Stamp>}>
        <div className={ui.statGrid}>
          <Stat label="quick-game cap per person" value={st?.dailyCap ?? '...'} />
          <Stat label="quick-game points paid" value={st?.pointsPaid ?? '...'} />
        </div>
        <Button tone={st?.settings.enabled ? 'pink' : 'lime'} icon={st?.settings.enabled ? 'lock' : 'play'} onClick={() => set.mutate({ enabled: !st?.settings.enabled })}>
          {st?.settings.enabled ? 'close the arcade' : 'open the arcade'}
        </Button>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>game</th>
              <th>runs</th>
              <th>players</th>
              <th>flagged</th>
              <th>best</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st?.games.map((g) => {
              const on = st.settings.games[g.id] !== false;
              return (
                <tr key={g.id}>
                  <td>
                    <b>{ARCADE_GAMES[g.id].title}</b>
                  </td>
                  <td className={ui.num}>{g.runs}</td>
                  <td className={ui.num}>{g.players}</td>
                  <td className={ui.num}>{g.flagged}</td>
                  <td>{g.best?.label ?? '-'}</td>
                  <td>
                    <Button size="sm" tone={on ? 'paper' : 'lime'} onClick={() => set.mutate({ games: { [g.id]: !on } })}>
                      {on ? 'switch off' : 'switch on'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section title="danger zone" tilt={0.2}>
        <p className={ui.hand}>wipes every quick-game run and best, and takes back quick-game points. the puzzle hour has its own reset above.</p>
        <div className={ui.row}>
          <TextField label={`type ${CONFIRM}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button tone="pink" disabled={confirm !== CONFIRM} onClick={() => reset.mutate(undefined, { onSuccess: () => setConfirm('') })}>
            reset arcade
          </Button>
        </div>
      </Section>
    </div>
  );
}

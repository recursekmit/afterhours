/* Console: Morse on/off, stats, speed round start/end, typed-confirm reset. */
import { OkSchema } from '@afterhours/shared';
import { MORSE_RESET_PHRASE, type MorseMode, MorseOverviewSchema, SprintPublicSchema } from '@afterhours/shared/features/morse';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { Button, Countdown, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, ui } from '../common/ui';

export default function MorseConsole() {
  const toast = useToast();
  const ov = useQuery({ queryKey: ['morse', 'admin'], queryFn: () => api.get('/api/morse/admin', MorseOverviewSchema), refetchInterval: 4000 });
  useLiveEvent('morse.state', () => void ov.refetch());
  useLiveEvent('morse.cleared', () => void ov.refetch());
  const [mode, setMode] = useState<MorseMode>('decode');
  const [level, setLevel] = useState(2);
  const [secs, setSecs] = useState(120);
  const [confirm, setConfirm] = useState('');
  const done = { onSuccess: () => void ov.refetch(), onError: (e: Error) => toast(e.message, { kind: 'bad' }) };
  const enable = useMutation({ mutationFn: (enabled: boolean) => api.put('/api/morse/admin/enabled', { enabled }, OkSchema), ...done });
  const sprint = useMutation({ mutationFn: () => api.post('/api/morse/admin/sprint', { mode, level, durationSec: secs }, SprintPublicSchema), ...done });
  const endSprint = useMutation({ mutationFn: () => api.post('/api/morse/admin/sprint/end', {}, OkSchema), ...done });
  const reset = useMutation({ mutationFn: () => api.post('/api/morse/admin/reset', { confirm: MORSE_RESET_PHRASE }, OkSchema), ...done });
  const o = ov.data;
  return (
    <div className={ui.stack}>
      <Section title="online morse ladder" tape action={o && <Stamp tone={o.enabled ? 'live' : 'done'}>{o.enabled ? 'on' : 'off'}</Stamp>}>
        <div className={ui.statGrid}>
          <Stat label="players" value={o?.players ?? '...'} />
          <Stat label="rounds running" value={o?.activeRounds ?? '...'} />
        </div>
        <div className={ui.row}>
          <Button tone={o?.enabled ? 'pink' : 'lime'} icon={o?.enabled ? 'lock' : 'play'} onClick={() => enable.mutate(!o?.enabled)}>
            {o?.enabled ? 'switch the online ladder off' : 'switch the online ladder on'}
          </Button>
          <span className={ui.hand}>this switch is the online ladder only (decode and encode levels on the phone). the morse slip tickets are shown or hidden in the hunt panel: "show morse challenge to players".</span>
        </div>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>level</th>
              <th>decode cleared</th>
              <th>encode cleared</th>
            </tr>
          </thead>
          <tbody>
            {o?.clears.decode.map((n, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className={ui.num}>{n}</td>
                <td className={ui.num}>{o.clears.encode[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="speed round" tilt={0.3}>
        {o?.sprint ? (
          <div className={ui.row}>
            <span className={ui.handBig}>
              {o.sprint.sprint.mode} level {o.sprint.sprint.level}, ends in <Countdown to={o.sprint.sprint.endsAt} />, {o.sprint.players} playing
            </span>
            <Button tone="pink" onClick={() => endSprint.mutate()}>
              end it now and pay the podium
            </Button>
          </div>
        ) : (
          <div className={ui.row}>
            <label className={ui.label}>
              mode
              <select className={ui.select} value={mode} onChange={(e) => setMode(e.target.value as MorseMode)}>
                <option value="decode">decode</option>
                <option value="encode">encode</option>
              </select>
            </label>
            <TextField label="level" type="number" min={1} max={5} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
            <TextField label="seconds" type="number" min={30} max={600} value={secs} onChange={(e) => setSecs(Number(e.target.value))} />
            <Button tone="sun" icon="bolt" onClick={() => sprint.mutate()} disabled={!o?.enabled}>
              start speed round
            </Button>
          </div>
        )}
      </Section>
      <Section title="danger zone" tilt={-0.2}>
        <p className={ui.hand}>wipes every morse round, best and speed round, and takes back morse points and stickers.</p>
        <div className={ui.row}>
          <TextField label={`type ${MORSE_RESET_PHRASE}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button tone="pink" disabled={confirm !== MORSE_RESET_PHRASE} onClick={() => reset.mutate(undefined, { onSuccess: () => setConfirm('') })}>
            reset morse
          </Button>
        </div>
      </Section>
    </div>
  );
}

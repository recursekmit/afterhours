/*
  Console, top of the hunt panel: what players can see. One big switch per event, both off by default.
  - "show treasure hunt to players": trails of kind hunt and other (stickers, riddles). Off = no hunt tab,
    no home card, no projector map, no feed lines, and the attendee API says "not open yet".
  - "show morse challenge to players": trails of kind morse, i.e. the morse slip (one unique ticket per
    kit), shown under the Morse tab. The online Morse ladder (decode/encode levels) has its own switch in
    the morse panel.
  Flipping a switch reaches every phone live.
*/
import { type HuntVisibility, HuntVisibilitySchema, MorseSlipSetupSchema, TrailAdminListSchema } from '@afterhours/shared/features/hunt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { Button, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import s from './hunt.module.css';

const SWITCHES: { key: keyof HuntVisibility; title: string; what: string }[] = [
  { key: 'hunt', title: 'show treasure hunt to players', what: 'trails of kind hunt and other: the sticker and riddle hunt. off: no hunt tab, card, projector map or feed lines; the API says "not open yet".' },
  { key: 'morse', title: 'show morse challenge to players', what: 'trails of kind morse: the morse slip (one ticket per kit), under the Morse tab. the online ladder has its own switch in the morse panel.' },
];

export function PlayerSwitches({ onOpenTrail }: { onOpenTrail: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['hunt', 'admin-visibility'], queryFn: () => api.get('/api/hunt/visibility', HuntVisibilitySchema) });
  useLiveEvent('hunt.visibility', (v) => qc.setQueryData(['hunt', 'admin-visibility'], v));
  const trails = useQuery({ queryKey: ['hunt', 'admin-trails'], queryFn: () => api.get('/api/hunt/admin/trails', TrailAdminListSchema) });
  const flip = useMutation({
    mutationFn: (patch: Partial<HuntVisibility>) => api.put('/api/hunt/admin/visibility', patch, HuntVisibilitySchema),
    onSuccess: (v) => {
      qc.setQueryData(['hunt', 'admin-visibility'], v);
      toast(`treasure hunt ${v.hunt ? 'shown' : 'hidden'}, morse challenge ${v.morse ? 'shown' : 'hidden'}`, { kind: 'good' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const makeSlip = useMutation({
    mutationFn: () => api.post('/api/hunt/admin/morse-slip', undefined, MorseSlipSetupSchema),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['hunt'] });
      toast(r.created ? 'the morse slip is ready: 80 unique tickets. print them from its slips tab.' : 'the morse slip already exists.', { kind: 'good' });
      onOpenTrail(r.trailId);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const v = q.data;
  const hasSlip = trails.data?.trails.some((t) => t.kind === 'morse' && t.title === 'the morse slip') ?? true;
  return (
    <Section title="what players can see" tape>
      <div className={s.switches}>
        {SWITCHES.map((sw) => {
          const on = v?.[sw.key] ?? false;
          return (
            <div key={sw.key} className={`${s.switchCard} ${on ? s.switchOn : ''}`} data-testid={`switch-${sw.key}`} data-on={on}>
              <div className={ui.between}>
                <b className={s.switchTitle}>{sw.title}</b>
                <Stamp tone={on ? 'live' : 'done'} rot={0}>
                  {on ? 'shown' : 'hidden'}
                </Stamp>
              </div>
              <p className={ui.hand}>{sw.what}</p>
              <Button tone={on ? 'pink' : 'lime'} size="lg" icon={on ? 'lock' : 'play'} loading={flip.isPending && flip.variables?.[sw.key] !== undefined} disabled={!v} onClick={() => flip.mutate({ [sw.key]: !on })}>
                {on ? 'hide from players' : 'show to players'}
              </Button>
            </div>
          );
        })}
      </div>
      {!hasSlip && (
        <div className={ui.row}>
          <Button tone="sky" icon="ticket" loading={makeSlip.isPending} onClick={() => makeSlip.mutate()} data-testid="create-morse-slip">
            create the morse slip (80 unique tickets)
          </Button>
          <span className={ui.hand}>one unique ticket per kit, no venue locations. the switches stay as they are.</span>
        </div>
      )}
    </Section>
  );
}

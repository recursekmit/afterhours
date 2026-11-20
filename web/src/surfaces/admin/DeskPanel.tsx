/*
  Desk mode: the entry-desk volunteer scans a student's ID with the laptop
  camera (or types a roll or name) and sees at once: on the list or not,
  signed in or not, which phone state; and can unbind, edit or add a walk-in.
*/
import { DeskLookupResponseSchema, type ParticipantRow } from '@afterhours/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../core/api';
import { qk } from '../../core/queries';
import { IdScanner } from '../../features/common/IdScanner';
import { Button, Card, EmptyState, ErrorState, LoadingState, Scribble, TextField } from '../../kit';
import s from './admin.module.css';
import p from './participants.module.css';
import { AddWalkIn, ConfirmSheet, EditSheet, time, useParticipantActions } from './ParticipantsPanel';

function Person({ r, pick, onUnbind, onEdit }: { r: ParticipantRow; pick: boolean; onUnbind: () => void; onEdit: () => void }) {
  const verdict = r.attendee ? (r.bound ? 'signed in' : 'signed in, phone unbound') : 'on the list, not signed in yet';
  return (
    <Card tone="paper" tilt={pick ? -0.4 : 0.3} className={pick ? p.pick : undefined} data-testid={`desk-person-${r.roll}`}>
      <div className={p.person}>
        <div className={p.personHead}>
          <h2 className={p.personName}>{r.name}</h2>
          <span className={p.personRoll}>{r.roll}</span>
          {pick && <span className={p.tag}>this card</span>}
        </div>
        <p className={`${p.verdict} ${r.attendee ? p.vIn : p.vWaiting}`}>{verdict}</p>
        <dl className={p.facts}>
          <dt>class</dt>
          <dd>{[r.year, r.section].filter(Boolean).join(', ') || 'not given'}</dd>
          <dt>phone</dt>
          <dd>{r.phone ? `ends ${r.phone.replace(/\D/g, '').slice(-4)}` : 'none on file'}</dd>
          {r.attendee && (
            <>
              <dt>signed in</dt>
              <dd>
                {time(r.attendee.firstSignInAt)}
                {r.attendee.nickname ? `, as ${r.attendee.nickname}` : ', profile not done'}
              </dd>
              <dt>points</dt>
              <dd>{r.attendee.points}</dd>
            </>
          )}
          {r.resets > 0 && (
            <>
              <dt>unbound</dt>
              <dd>{r.resets} time{r.resets === 1 ? '' : 's'}</dd>
            </>
          )}
          {r.note && (
            <>
              <dt>note</dt>
              <dd>{r.note}</dd>
            </>
          )}
        </dl>
        <div className={s.row}>
          {r.bound && (
            <Button tone="sun" icon="undo" onClick={onUnbind}>
              unbind phone
            </Button>
          )}
          <Button tone="paper" size="sm" onClick={onEdit}>
            edit details
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function DeskPanel() {
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [camera, setCamera] = useState(false);
  const [editing, setEditing] = useState<ParticipantRow | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'unbind' | 'remove'; row: ParticipantRow } | null>(null);
  const { unbind } = useParticipantActions();
  const look = useQuery({
    queryKey: [...qk.participants, 'desk', q],
    queryFn: () => api.post('/api/admin/desk/lookup', { q }, DeskLookupResponseSchema),
    enabled: q.trim().length > 0,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) setQ(typed.trim());
  };
  const data = look.data;
  const typedRoll = data && data.read !== 'qr' && /^[A-Za-z0-9 -]{6,20}$/.test(q) ? q.toUpperCase().replace(/[\s-]/g, '') : '';

  return (
    <div className={s.panel}>
      <header className={s.panelHead}>
        <h1 className={s.panelTitle}>entry desk</h1>
        <Scribble color="var(--sky)" style={{ width: 200 }} />
        <p className={s.note}>scan a student's ID card, or type their roll or name. you see if they are on the list and signed in.</p>
      </header>
      <div className={p.desk}>
        <div className={s.stack}>
          <Card tone="paper" tape tapeColor="sun" tilt={-0.3}>
            <h2 className={s.cardTitle}>look someone up</h2>
            <form className={p.lookupRow} onSubmit={submit}>
              <TextField label="roll, card text or name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="26BD1A0501" data-testid="desk-query" />
              <Button type="submit" tone="lime" icon="search">
                look up
              </Button>
            </form>
          </Card>
          <Card tone="paper" tilt={0.3}>
            {camera ? (
              <IdScanner
                continuous
                hint="hold the ID card's QR up to the laptop camera"
                onCode={(t) => {
                  setTyped(t);
                  setQ(t);
                }}
                onCancel={() => setCamera(false)}
              />
            ) : (
              <Button tone="sun" size="lg" icon="qr" block onClick={() => setCamera(true)} data-testid="desk-camera">
                scan an ID card
              </Button>
            )}
          </Card>
        </div>
        <div className={s.stack} aria-live="polite">
          {!q ? (
            <EmptyState title="nobody yet" hint="scan a card or type a roll." />
          ) : look.isPending ? (
            <LoadingState label="looking..." />
          ) : look.isError ? (
            <ErrorState error={look.error} onRetry={() => void look.refetch()} />
          ) : data && data.matches.length === 0 ? (
            <Card tone="pink" tilt={-0.4} data-testid="desk-not-found">
              <div className={s.stack}>
                <p className={`${p.verdict} ${p.vNo}`}>not on the list</p>
                <p className={s.note}>
                  {data.read === 'qr'
                    ? `nobody on the list has a roll ending ${data.qr?.suffix}. ask for their full roll and add them below, or hand them an entry kit.`
                    : 'add them below in a few seconds, or hand them an entry kit.'}
                </p>
                <AddWalkIn roll={typedRoll} onAdded={(r) => setQ(r.roll)} />
              </div>
            </Card>
          ) : (
            data?.matches.map((r) => (
              <Person key={r.id} r={r} pick={data.pickId === r.id && data.matches.length > 1} onUnbind={() => setConfirm({ kind: 'unbind', row: r })} onEdit={() => setEditing(r)} />
            ))
          )}
          {data && data.read === 'qr' && data.matches.length > 1 && data.pickId === null && (
            <p className={s.note}>more than one person on the list shares {data.qr?.suffix}: their phone shows a "who are you?" picker.</p>
          )}
        </div>
      </div>
      <EditSheet row={editing} onClose={() => setEditing(null)} />
      <ConfirmSheet c={confirm} onClose={() => setConfirm(null)} pending={unbind.isPending} onGo={(c) => unbind.mutate(c.row, { onSuccess: () => setConfirm(null) })} />
    </div>
  );
}

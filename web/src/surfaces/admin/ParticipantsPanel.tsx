/*
  Participants panel (spec 4.1): the registered list people sign in from with
  their college ID. Import a CSV (paste or file), see who is in, add a walk-in,
  edit, unbind a phone, remove, export, and the stricter "also ask the phone
  digits" setting.
*/
import {
  type ImportReport,
  ImportReportSchema,
  type ParticipantInputBody,
  ParticipantListResponseSchema,
  type ParticipantRow,
  ParticipantRowSchema,
  ParticipantSettingsSchema,
  OkSchema,
} from '@afterhours/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { api } from '../../core/api';
import { qk } from '../../core/queries';
import { celebrate } from '../../fun';
import ui from '../../features/common/ui.module.css';
import { Button, Card, Doodle, EmptyState, ErrorState, LoadingState, NumberTicker, Scribble, Sheet, Tabs, TextArea, TextField, useToast } from '../../kit';
import s from './admin.module.css';
import { downloadText, toCsv } from './kitsStore';
import p from './participants.module.css';

type Filter = 'all' | 'in' | 'waiting' | 'notes';
export const time = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const maskPhone = (ph: string | null) => (ph ? `...${ph.replace(/\D/g, '').slice(-4)}` : '');

export function useParticipants() {
  return useQuery({ queryKey: qk.participants, queryFn: () => api.get('/api/admin/participants', ParticipantListResponseSchema), refetchInterval: 5000 });
}

function Import({ onReport }: { onReport: (r: ImportReport) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: (text: string) => api.post('/api/admin/participants/import', { csv: text }, ImportReportSchema),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.participants });
      onReport(r);
      setCsv('');
      if (r.added) celebrate({ y: 0.5, sound: false });
      toast(`${r.added} added, ${r.duplicates.length} duplicates, ${r.conflicts.length} conflicts`, { kind: r.conflicts.length ? 'info' : 'good', title: 'list imported' });
    },
    onError: (e) => toast(e.message, { kind: 'bad', title: 'import failed' }),
  });
  return (
    <Card tone="paper" tape tapeColor="sky" tilt={-0.4}>
      <h2 className={s.cardTitle}>import the list</h2>
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          if (csv.trim()) run.mutate(csv);
        }}
      >
        <TextArea
          label="paste name, year, section, roll, phone, email"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={6}
          placeholder={'name,year,section,roll,phone,email\nAarav Reddy,1st,CSE-A,26BD1A0501,9000000001,aarav@example.com'}
          hint="straight from the form's sheet: commas or tabs, a header row is fine. same roll twice keeps the first."
        />
        <div className={s.row}>
          <Button type="submit" tone="lime" icon="users" loading={run.isPending} disabled={!csv.trim()}>
            import
          </Button>
          <Button tone="paper" icon="download" onClick={() => file.current?.click()}>
            from a file
          </Button>
          <input
            ref={file}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            hidden
            data-testid="participants-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((t) => run.mutate(t));
              e.target.value = '';
            }}
          />
        </div>
      </form>
    </Card>
  );
}

function ReportCard({ r, onClose }: { r: ImportReport; onClose: () => void }) {
  return (
    <Card tone="sun" tilt={0.4} halftone tape="left" tapeColor="pink" data-testid="import-report">
      <div className={s.stack}>
        <h2 className={s.cardTitle}>
          <NumberTicker value={r.added} /> added from {r.rows} rows
        </h2>
        <p className={s.note}>
          {r.existing ? `${r.existing} already on the list. ` : ''}
          {r.duplicates.length} exact duplicates dropped. {r.conflicts.length} conflicts kept as the first and noted for the desk.
        </p>
        {r.conflicts.length > 0 && (
          <div>
            <h3 className={p.subhead}>conflicts: same roll, different {`name or phone`}</h3>
            <ul className={p.list}>
              {r.conflicts.map((c) => (
                <li key={`${c.line}-${c.roll}`}>
                  <b>{c.roll}</b>: kept "{c.keptName}", also given by "{c.name}" (line {c.line}, differs: {c.differs.join(' + ')})
                </li>
              ))}
            </ul>
          </div>
        )}
        {r.duplicates.length > 0 && (
          <div>
            <h3 className={p.subhead}>duplicates dropped</h3>
            <ul className={p.list}>
              {r.duplicates.map((d) => (
                <li key={`${d.line}-${d.roll}`}>
                  {d.roll} {d.name} (line {d.line})
                </li>
              ))}
            </ul>
          </div>
        )}
        {r.flagged.length > 0 && (
          <div>
            <h3 className={p.subhead}>worth a look</h3>
            <ul className={p.list}>
              {r.flagged.map((f) => (
                <li key={f.roll}>
                  {f.roll} "{f.name}": {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {r.skipped.length > 0 && (
          <div>
            <h3 className={p.subhead}>skipped</h3>
            <ul className={p.list}>
              {r.skipped.map((k) => (
                <li key={k.line}>
                  line {k.line}: {k.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button tone="paper" size="sm" ghost onClick={onClose}>
          got it
        </Button>
      </div>
    </Card>
  );
}

const EMPTY: ParticipantInputBody = { name: '', roll: '', year: '', section: '', phone: '', email: '', note: '' };

export function PersonForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  compact,
}: {
  initial: ParticipantInputBody;
  submitLabel: string;
  pending: boolean;
  onSubmit: (b: ParticipantInputBody) => void;
  compact?: boolean;
}) {
  const [v, setV] = useState<ParticipantInputBody>(initial);
  const set = (k: keyof ParticipantInputBody) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v);
  };
  return (
    <form className={s.stack} onSubmit={submit}>
      <div className={p.formGrid}>
        <TextField label="name" value={v.name} onChange={set('name')} required />
        <TextField label="roll" value={v.roll} onChange={set('roll')} required autoCapitalize="characters" style={{ textTransform: 'uppercase' }} />
        <TextField label="phone" value={v.phone ?? ''} onChange={set('phone')} inputMode="tel" hint="its last 4 digits are the typed sign-in" />
        {!compact && <TextField label="section" value={v.section ?? ''} onChange={set('section')} />}
        {!compact && <TextField label="year" value={v.year ?? ''} onChange={set('year')} />}
        {!compact && <TextField label="email" value={v.email ?? ''} onChange={set('email')} />}
        {!compact && <TextField label="desk note" value={v.note ?? ''} onChange={set('note')} />}
      </div>
      <Button type="submit" tone="lime" icon="plus" loading={pending} disabled={!v.name.trim() || !v.roll.trim()}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function AddWalkIn({ roll = '', onAdded }: { roll?: string; onAdded?: (r: ParticipantRow) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState(0);
  const add = useMutation({
    mutationFn: (b: ParticipantInputBody) => api.post('/api/admin/participants', b, ParticipantRowSchema),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.participants });
      toast(`${r.name} (${r.roll}) can scan their ID now.`, { kind: 'good', title: 'added' });
      setKey((k) => k + 1);
      onAdded?.(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad', title: 'could not add' }),
  });
  return <PersonForm key={key} compact initial={{ ...EMPTY, roll }} submitLabel="add to the list" pending={add.isPending} onSubmit={(b) => add.mutate(b)} />;
}

function Settings({ strict }: { strict: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const set = useMutation({
    mutationFn: (strictPhone: boolean) => api.put('/api/admin/idlogin/settings', { strictPhone }, ParticipantSettingsSchema),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.participants });
      toast(r.strictPhone ? 'a scan now also asks for the last 4 phone digits' : 'a scan alone signs people in', { kind: 'info' });
    },
  });
  return (
    <label className={ui.toggle}>
      <input type="checkbox" checked={strict} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} data-testid="strict-phone" />
      also ask the last 4 phone digits after a QR scan (stricter, off by default)
    </label>
  );
}

/** Unbind / edit / remove actions, shared with desk mode. */
export function useParticipantActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const done = () => void qc.invalidateQueries({ queryKey: qk.participants });
  const unbind = useMutation({
    mutationFn: (r: ParticipantRow) => api.post(`/api/admin/participants/${r.id}/unbind`, {}, ParticipantRowSchema),
    onSuccess: (r) => {
      done();
      toast(`${r.name} can sign in on a new phone now. the old phone is signed out.`, { kind: 'good', title: 'unbound' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const remove = useMutation({
    mutationFn: (r: ParticipantRow) => api.del(`/api/admin/participants/${r.id}`, OkSchema),
    onSuccess: () => {
      done();
      toast('removed from the list', { kind: 'info' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const edit = useMutation({
    mutationFn: ({ id, body }: { id: number; body: ParticipantInputBody }) => api.put(`/api/admin/participants/${id}`, body, ParticipantRowSchema),
    onSuccess: () => {
      done();
      toast('saved', { kind: 'good' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return { unbind, remove, edit };
}

export function EditSheet({ row, onClose }: { row: ParticipantRow | null; onClose: () => void }) {
  const { edit } = useParticipantActions();
  return (
    <Sheet open={row !== null} onClose={onClose} placement="center" title={`edit ${row?.roll ?? ''}`}>
      {row && (
        <PersonForm
          initial={{ name: row.name, roll: row.roll, year: row.year ?? '', section: row.section ?? '', phone: row.phone ?? '', email: row.email ?? '', note: row.note }}
          submitLabel="save"
          pending={edit.isPending}
          onSubmit={(body) => edit.mutate({ id: row.id, body }, { onSuccess: onClose })}
        />
      )}
    </Sheet>
  );
}

export function StatusBadge({ r }: { r: ParticipantRow }) {
  if (!r.attendee) return <span className={s.faint}>not yet</span>;
  return (
    <span className={s.inBadge}>
      <Doodle name="check" size={14} /> {time(r.attendee.firstSignInAt)}
      {!r.bound && <span className={p.unbound}> (unbound)</span>}
    </span>
  );
}

function Table() {
  const list = useParticipants();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<ParticipantRow | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'unbind' | 'remove'; row: ParticipantRow } | null>(null);
  const { unbind, remove } = useParticipantActions();
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.participants ?? []).filter((r) => {
      if (filter === 'in' && !r.attendee) return false;
      if (filter === 'waiting' && r.attendee) return false;
      if (filter === 'notes' && !r.note) return false;
      if (!needle) return true;
      return [r.roll, r.name, r.attendee?.nickname, r.section, r.note].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [list.data, q, filter]);

  if (list.isPending) return <LoadingState label="reading the list..." />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  const { stats, participants } = list.data;
  const withNotes = participants.filter((r) => r.note).length;

  const exportCsv = () =>
    downloadText(
      'afterhours-participants.csv',
      toCsv([
        ['roll', 'name', 'signed_in_at', 'points'],
        ...participants.map((r) => [r.roll, r.name, r.attendee ? new Date(r.attendee.firstSignInAt).toISOString() : null, r.attendee ? String(r.attendee.points) : '0']),
      ]),
    );

  return (
    <section className={s.stack} aria-label="participants">
      <div className={s.stats}>
        <Card tone="tangerine" tilt={-1.2} halftone>
          <p className={s.statLabel}>on the list</p>
          <NumberTicker value={stats.total} className={s.statNum} />
        </Card>
        <Card tone="lime" tilt={1} halftone>
          <p className={s.statLabel}>signed in</p>
          <NumberTicker value={stats.signedIn} className={s.statNum} />
        </Card>
        <Card tone="pink" tilt={-0.6} halftone>
          <p className={s.statLabel}>still to come</p>
          <NumberTicker value={stats.total - stats.signedIn} className={s.statNum} />
        </Card>
      </div>

      <Card tone="paper" tilt={0.2} className={s.tableCard}>
        <div className={s.tableHead}>
          <h2 className={s.cardTitle}>who is in</h2>
          <TextField label="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, roll, nickname" className={s.search} />
          <Tabs
            label="filter participants"
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'all', label: `all ${stats.total}` },
              { id: 'in', label: `in ${stats.signedIn}` },
              { id: 'waiting', label: `waiting ${stats.total - stats.signedIn}` },
              { id: 'notes', label: `notes ${withNotes}` },
            ]}
          />
          <Button tone="paper" size="sm" icon="download" onClick={exportCsv} disabled={stats.total === 0}>
            export csv
          </Button>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={stats.total === 0 ? 'nobody on the list yet' : 'nobody matches'} hint={stats.total === 0 ? 'import the form responses above.' : 'try a different search.'} />
        ) : (
          <div className={s.tableScroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>roll</th>
                  <th>who</th>
                  <th>class</th>
                  <th>phone</th>
                  <th>signed in</th>
                  <th>pts</th>
                  <th>
                    <span className={s.srOnly}>actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`participant-${r.roll}`}>
                    <td className={s.kitCell}>{r.roll}</td>
                    <td>
                      <b>{r.name}</b>
                      {r.attendee?.nickname && <span className={s.faint}> aka {r.attendee.nickname}</span>}
                      {r.source === 'walkin' && <span className={p.tag}>walk-in</span>}
                      {r.note && <span className={p.noteTag}>{r.note}</span>}
                    </td>
                    <td className={s.faint}>{[r.year, r.section].filter(Boolean).join(', ')}</td>
                    <td className={s.faint}>{maskPhone(r.phone)}</td>
                    <td>
                      <StatusBadge r={r} />
                    </td>
                    <td>{r.attendee?.points ?? ''}</td>
                    <td className={s.actionCell}>
                      <div className={p.actions}>
                        <Button tone="paper" size="sm" onClick={() => setEditing(r)} aria-label={`edit ${r.roll}`}>
                          edit
                        </Button>
                        {r.bound && (
                          <Button tone="sun" size="sm" icon="undo" onClick={() => setConfirm({ kind: 'unbind', row: r })} aria-label={`unbind ${r.roll}`}>
                            unbind
                          </Button>
                        )}
                        {!r.attendee && (
                          <Button tone="paper" size="sm" ghost onClick={() => setConfirm({ kind: 'remove', row: r })} aria-label={`remove ${r.roll}`}>
                            remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <EditSheet row={editing} onClose={() => setEditing(null)} />
      <ConfirmSheet
        c={confirm}
        onClose={() => setConfirm(null)}
        pending={unbind.isPending || remove.isPending}
        onGo={(c) => (c.kind === 'unbind' ? unbind : remove).mutate(c.row, { onSuccess: () => setConfirm(null) })}
      />
    </section>
  );
}

export function ConfirmSheet({
  c,
  onClose,
  onGo,
  pending,
}: {
  c: { kind: 'unbind' | 'remove'; row: ParticipantRow } | null;
  onClose: () => void;
  onGo: (c: { kind: 'unbind' | 'remove'; row: ParticipantRow }) => void;
  pending: boolean;
}) {
  return (
    <Sheet open={c !== null} onClose={onClose} placement="center" title={c?.kind === 'remove' ? `remove ${c.row.roll}?` : `unbind ${c?.row.roll ?? ''}?`}>
      {c && (
        <div className={s.stack}>
          <p>
            {c.kind === 'unbind'
              ? `${c.row.attendee?.nickname ?? c.row.name} gets signed out on their current phone and can scan in on a new one. Points, stickers and free mocktails stay.`
              : `${c.row.name} comes off the list. They have not signed in, so nothing else is lost.`}
          </p>
          <Button tone={c.kind === 'unbind' ? 'sun' : 'pink'} loading={pending} onClick={() => onGo(c)}>
            {c.kind === 'unbind' ? 'unbind the phone' : 'remove them'}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function ParticipantsPanel() {
  const [report, setReport] = useState<ImportReport | null>(null);
  const list = useParticipants();
  return (
    <div className={s.panel}>
      <header className={s.panelHead}>
        <h1 className={s.panelTitle}>participants</h1>
        <Scribble color="var(--lime)" style={{ width: 220 }} />
        <p className={s.note}>the registered list. they sign in by scanning their college ID; kits stay for walk-ins and spares.</p>
      </header>
      <div className={s.twoCol}>
        <Import onReport={setReport} />
        <div className={s.stack}>
          {report && <ReportCard r={report} onClose={() => setReport(null)} />}
          <Card tone="paper" tilt={0.3} tape tapeColor="lime">
            <h2 className={s.cardTitle}>add a walk-in</h2>
            <AddWalkIn />
          </Card>
          {list.data && (
            <Card tone="paper" tilt={-0.2}>
              <Settings strict={list.data.settings.strictPhone} />
            </Card>
          )}
        </div>
      </div>
      <Table />
    </div>
  );
}

/*
  Console panel "stalls": everything the organisers set up and watch on the day.
  - settings: free mocktails per person, and the (not wired yet) "spending lowers the board" switch
  - stalls: name, mark, location, the shopkeeper's code (rotate it), open or closed, live sales
  - items: price, stock (blank = unlimited), per-person limit, free-mocktail flag, a photo
  - paste a CSV menu, read the transaction list, void a purchase, export everything
*/
import { OkSchema } from '@afterhours/shared';
import {
  AdminOverviewSchema,
  AdminTxnsSchema,
  type AdminItem,
  type AdminStall,
  ImportResultSchema,
  MAX_ALLOWANCE,
  RESET_CONFIRM,
  RotateResultSchema,
  StallSettingsSchema,
} from '@afterhours/shared/features/stalls';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { Button, Card, Doodle, ErrorState, LoadingState, TextArea, TextField, useToast } from '../../kit';
import { Section, Stamp, Stat, downloadHref, ui } from '../common/ui';
import { StallMark, Thumb, clockTime, fileToUpload, linesText } from './parts';
import s from './stalls.module.css';

const OV = ['stalls', 'admin', 'overview'] as const;
const TX = ['stalls', 'admin', 'txns'] as const;
const IdSchema = z.object({ id: z.number() });
const ImageSchema = z.object({ image: z.string() });

function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stalls', 'admin'] }),
    onError: (e: Error) => toast(e.message, { kind: 'bad', title: 'did not save' }),
  });
}

function NumCell({ value, blank, min = 0, label, onSave }: { value: number | null; blank?: string; min?: number; label: string; onSave: (n: number | null) => void }) {
  const [v, setV] = useState(value === null ? '' : String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setV(value === null ? '' : String(value));
  }
  const commit = () => {
    const t = v.trim();
    if (t === '') return value === null ? undefined : onSave(null);
    const n = Number(t);
    if (!Number.isInteger(n) || n < min) return setV(value === null ? '' : String(value));
    if (n !== value) onSave(n);
  };
  return <input className={s.cellInput} inputMode="numeric" aria-label={label} placeholder={blank} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function ItemRow({ item, act }: { item: AdminItem; act: (f: () => Promise<unknown>) => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const patch = (body: Record<string, unknown>) => act(() => api.patch(`/api/stalls/admin/items/${item.id}`, body, OkSchema));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = await fileToUpload(f);
      act(() => api.post(`/api/stalls/admin/items/${item.id}/image`, { data }, ImageSchema));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That image did not work.', { kind: 'bad' });
    }
  };
  return (
    <tr className={item.active ? '' : s.rowOff}>
      <td>
        <button type="button" className={s.thumbBtn} onClick={() => file.current?.click()} aria-label={`photo for ${item.name}`} title="click to upload a photo (max 300 KB, big ones are shrunk for you)">
          <Thumb src={item.image} name={item.name} size={44} />
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      </td>
      <td>
        <input className={s.cellInput} style={{ minWidth: 140 }} aria-label="item name" defaultValue={item.name} onBlur={(e) => e.target.value.trim() && e.target.value !== item.name && patch({ name: e.target.value.trim() })} />
      </td>
      <td>
        <NumCell value={item.price} label={`price of ${item.name}`} onSave={(n) => n !== null && patch({ price: n })} />
      </td>
      <td>
        <NumCell value={item.stock} blank="no limit" label={`stock of ${item.name}`} onSave={(n) => patch({ stock: n })} />
      </td>
      <td className={ui.num}>{item.stockLeft === null ? 'any' : item.stockLeft}</td>
      <td>
        <NumCell value={item.limit} blank="none" min={1} label={`per-person limit of ${item.name}`} onSave={(n) => patch({ limit: n })} />
      </td>
      <td>
        <label className={ui.toggle}>
          <input type="checkbox" checked={item.freeDrink} onChange={(e) => patch({ freeDrink: e.target.checked })} />
          free
        </label>
      </td>
      <td className={ui.num}>{item.sold}</td>
      <td className={s.actions}>
        {item.image && (
          <Button size="sm" tone="paper" onClick={() => act(() => api.del(`/api/stalls/admin/items/${item.id}/image`, OkSchema))}>
            no photo
          </Button>
        )}
        <Button size="sm" tone={item.active ? 'paper' : 'lime'} onClick={() => patch({ active: !item.active })}>
          {item.active ? 'hide' : 'show'}
        </Button>
        <Button size="sm" tone="pink" icon="close" aria-label={`delete ${item.name}`} onClick={() => confirm(`Delete ${item.name}? Items that already sold are only hidden.`) && act(() => api.del(`/api/stalls/admin/items/${item.id}`, z.object({ result: z.string() })))} />
      </td>
    </tr>
  );
}

function AddItem({ stallId, act }: { stallId: number; act: (f: () => Promise<unknown>) => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('0');
  const [stock, setStock] = useState('');
  const [limit, setLimit] = useState('');
  const [free, setFree] = useState(false);
  const submit = () => {
    if (!name.trim()) return;
    act(() =>
      api.post('/api/stalls/admin/items', { stallId, name: name.trim(), price: Number(price) || 0, stock: stock.trim() === '' ? null : Number(stock), limit: limit.trim() === '' ? null : Number(limit), freeDrink: free }, IdSchema),
    );
    setName('');
    setStock('');
    setLimit('');
    setFree(false);
  };
  return (
    <form
      className={s.addRow}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <TextField label="new item" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. mocktail of the day" />
      <TextField label="price (pts)" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
      <TextField label="stock" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="blank = no limit" />
      <TextField label="max each" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="blank = none" />
      <label className={ui.toggle}>
        <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} />
        free mocktail
      </label>
      <Button type="submit" tone="lime" icon="plus" disabled={!name.trim()}>
        add item
      </Button>
    </form>
  );
}

function StallBlock({ st, act }: { st: AdminStall; act: (f: () => Promise<unknown>) => void }) {
  const toast = useToast();
  const [showCode, setShowCode] = useState(true);
  const patch = (body: Record<string, unknown>) => act(() => api.patch(`/api/stalls/admin/stalls/${st.id}`, body, OkSchema));
  return (
    <Section
      title={st.name}
      tilt={0.2}
      action={
        <span className={ui.row}>
          <Stamp tone={st.active ? 'live' : 'late'}>{st.active ? 'open' : 'closed'}</Stamp>
          <Button size="sm" tone="paper" onClick={() => patch({ active: !st.active })}>
            {st.active ? 'close stall' : 'reopen'}
          </Button>
        </span>
      }
    >
      <div className={s.stallHead}>
        <div className={s.codeBox}>
          <p className={ui.hand}>shopkeeper code (they sign in at /stall)</p>
          <p className={s.codeBig} aria-label={`stall code ${st.code.split('').join(' ')}`}>
            {showCode ? `${st.code.slice(0, 3)} ${st.code.slice(3)}` : '*** ***'}
          </p>
          <div className={ui.row}>
            <Button size="sm" tone="paper" onClick={() => setShowCode((v) => !v)}>
              {showCode ? 'hide' : 'show'}
            </Button>
            <Button
              size="sm"
              tone="sky"
              icon="copy"
              onClick={() => {
                void navigator.clipboard?.writeText(st.code);
                toast('code copied', { kind: 'good' });
              }}
            >
              copy
            </Button>
            <Button size="sm" tone="pink" icon="undo" onClick={() => confirm('Rotate the code? Anyone signed in at this stall is signed out.') && act(() => api.post(`/api/stalls/admin/stalls/${st.id}/rotate`, {}, RotateResultSchema))}>
              rotate
            </Button>
          </div>
        </div>
        <div className={s.stallFields}>
          <TextField label="name" defaultValue={st.name} maxLength={40} onBlur={(e) => e.target.value.trim() && e.target.value !== st.name && patch({ name: e.target.value.trim() })} />
          <TextField label="mark (emoji, or doodle:star)" defaultValue={st.emoji} maxLength={24} onBlur={(e) => e.target.value !== st.emoji && patch({ emoji: e.target.value.trim() })} suffix={<StallMark value={st.emoji} size={22} />} />
          <TextField label="where" defaultValue={st.location} maxLength={60} onBlur={(e) => e.target.value !== st.location && patch({ location: e.target.value.trim() })} />
        </div>
      </div>
      <div className={ui.statGrid}>
        <Stat label="hand-overs" value={st.sales.txns} />
        <Stat label="things given" value={st.sales.units} />
        <Stat label="free mocktails" value={st.sales.freeUnits} />
        <Stat label="points taken" value={st.sales.points} />
      </div>
      <div className={s.tableScroll}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th />
              <th>item</th>
              <th>pts</th>
              <th>stock</th>
              <th>left</th>
              <th>max each</th>
              <th>free drink</th>
              <th>sold</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st.items.map((it) => (
              <ItemRow key={it.id} item={it} act={act} />
            ))}
            {st.items.length === 0 && (
              <tr>
                <td colSpan={9} className={ui.hand}>
                  no items yet. add one below, or paste a whole menu further down.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <AddItem stallId={st.id} act={act} />
      <p className={ui.hand}>"free mocktail" items use a person's free-drink allowance first. if it is used up they cost their points price (a price of 0 means refused).</p>
      <div className={ui.row}>
        <Button size="sm" tone="pink" icon="close" onClick={() => confirm(`Delete ${st.name}? A stall that already sold things is only closed.`) && act(() => api.del(`/api/stalls/admin/stalls/${st.id}`, z.object({ result: z.string() })))}>
          delete stall
        </Button>
      </div>
    </Section>
  );
}

function Settings({ ov, act }: { ov: z.infer<typeof AdminOverviewSchema>; act: (f: () => Promise<unknown>) => void }) {
  const [n, setN] = useState(String(ov.settings.allowance));
  return (
    <Section title="stalls and rewards" tape>
      <div className={ui.statGrid}>
        <Stat label="hand-overs" value={ov.totals.txns} />
        <Stat label="points spent" value={ov.totals.points} />
        <Stat label="free mocktails given" value={ov.totals.freeUnits} />
      </div>
      <div className={s.settingsRow}>
        <TextField
          label={`free mocktails per person (0 to ${MAX_ALLOWANCE})`}
          inputMode="numeric"
          value={n}
          onChange={(e) => setN(e.target.value)}
          onBlur={() => {
            const v = Number(n);
            if (Number.isInteger(v) && v >= 0 && v <= MAX_ALLOWANCE) {
              if (v !== ov.settings.allowance) act(() => api.patch('/api/stalls/admin/settings', { allowance: v }, StallSettingsSchema));
            } else setN(String(ov.settings.allowance));
          }}
          hint="applies to everyone, now. people who already had some keep what they used."
        />
        <label className={ui.toggle}>
          <input type="checkbox" checked={ov.settings.spendLowersBoard} onChange={(e) => act(() => api.patch('/api/stalls/admin/settings', { spendLowersBoard: e.target.checked }, StallSettingsSchema))} />
          spending lowers the leaderboard
        </label>
      </div>
      <p className={ui.hand}>
        leave the leaderboard switch off: the board ranks everything people earned, so buying a mocktail never costs anyone their rank. the switch is only saved for now; the board does not read it.
      </p>
    </Section>
  );
}

function AddStall({ act, title = 'add a stall', first = false }: { act: (f: () => Promise<unknown>) => void; title?: string; first?: boolean }) {
  const [name, setName] = useState(first ? 'snacks + merch' : '');
  const [emoji, setEmoji] = useState(first ? '\u{1F37F}' : '\u{1F379}');
  const [location, setLocation] = useState('');
  return (
    <Section title={title} tape={first} tilt={-0.2}>
      {first && (
        <p className={ui.hand}>
          after hours has <b>2 stalls</b>: the mocktail bar (ready below) and one for food and merch. 1. name it here and press create, you get its 6-digit shopkeeper code. 2. add its items in its block below (or paste the menu further down). 3. hand the code to its shopkeeper: they sign in at /stall.
        </p>
      )}
      <form
        className={s.addRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          act(() => api.post('/api/stalls/admin/stalls', { name: name.trim(), emoji: emoji.trim() || '\u{1F379}', location: location.trim() }, IdSchema));
          setName('');
          setLocation('');
        }}
      >
        <TextField label="stall name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Brew Bar" />
        <TextField label="mark (emoji, or doodle:star)" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={24} />
        <TextField label="where" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={60} placeholder="e.g. by the stage" />
        <Button type="submit" tone="lime" icon="plus" disabled={!name.trim()}>
          create, get a code
        </Button>
      </form>
    </Section>
  );
}

function ImportCsv({ act }: { act: (f: () => Promise<unknown>) => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const run = useMutation({
    mutationFn: () => api.post('/api/stalls/admin/import', { csv }, ImportResultSchema),
    onSuccess: (r) => {
      act(async () => undefined);
      toast(`${r.itemsCreated} added, ${r.itemsUpdated} updated, ${r.stallsCreated} new stalls${r.errors.length ? `, ${r.errors.length} rows skipped` : ''}`, { kind: r.errors.length ? 'info' : 'good', title: 'menu imported' });
      if (r.errors.length === 0) setCsv('');
      setErrors(r.errors);
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);
  return (
    <Section title="paste a menu" tilt={0.3}>
      <p className={ui.hand}>
        one row per item: <b>stall,item,price,stock,limit</b>. blank stock means unlimited, blank limit means none. add a sixth column <b>yes</b> for a free-mocktail item. pasting from a spreadsheet works. running it again updates items with the same name.
      </p>
      <TextArea label="menu" rows={7} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'stall,item,price,stock,limit\nsnacks + merch,Samosa,8,100,3\nsnacks + merch,Recurse sticker pack,20,50,1'} />
      <div className={ui.row}>
        <Button tone="lime" icon="download" disabled={!csv.trim()} loading={run.isPending} onClick={() => run.mutate()}>
          import
        </Button>
      </div>
      {errors.length > 0 && (
        <ul className={s.errors}>
          {errors.map((e) => (
            <li key={e.line}>
              line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DangerZone({ act }: { act: (f: () => Promise<unknown>) => void }) {
  const [typed, setTyped] = useState('');
  return (
    <Section title="danger zone" tilt={0.2}>
      <p className={ui.hand}>after the dry run: wipes every hand-over and basket, so everyone has their free mocktails again. stalls, menus, codes and earned points stay.</p>
      <div className={ui.row}>
        <TextField label={`type ${RESET_CONFIRM}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button
          tone="pink"
          disabled={typed !== RESET_CONFIRM}
          onClick={() => {
            act(() => api.post('/api/stalls/admin/reset', { confirm: RESET_CONFIRM }, OkSchema));
            setTyped('');
          }}
        >
          reset purchases
        </Button>
      </div>
    </Section>
  );
}

function Transactions({ act }: { act: (f: () => Promise<unknown>) => void }) {
  const q = useQuery({ queryKey: TX, queryFn: () => api.get('/api/stalls/admin/txns', AdminTxnsSchema), refetchInterval: 4000 });
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  const rows = (q.data?.txns ?? []).filter((t) => !needle || t.kitId.toLowerCase().includes(needle) || t.nickname.toLowerCase().includes(needle) || t.stallName.toLowerCase().includes(needle));
  return (
    <Section
      title="hand-overs"
      tilt={-0.3}
      action={
        <Button size="sm" tone="sky" icon="download" onClick={() => downloadHref('/api/stalls/admin/export.csv')}>
          export CSV
        </Button>
      }
    >
      <TextField label="find by kit, nickname or stall (to refund someone)" value={find} onChange={(e) => setFind(e.target.value)} placeholder="e.g. AH-042" />
      {q.isPending ? (
        <LoadingState label="loading..." />
      ) : q.data && q.data.txns.length === 0 ? (
        <p className={ui.hand}>nothing handed over yet.</p>
      ) : rows.length === 0 ? (
        <p className={ui.hand}>nothing matches "{find}".</p>
      ) : (
        <div className={s.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>time</th>
                <th>stall</th>
                <th>who</th>
                <th>what</th>
                <th>pts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.status === 'void' ? s.rowOff : ''}>
                  <td>{clockTime(t.at)}</td>
                  <td>{t.stallName}</td>
                  <td>
                    {t.nickname} <span className={ui.hand}>{t.kitId}</span>
                  </td>
                  <td>
                    {linesText(t.lines)}
                    {t.freeUsed > 0 ? ` (${t.freeUsed} free)` : ''}
                  </td>
                  <td className={ui.num}>{t.totalPoints}</td>
                  <td>
                    {t.status === 'void' ? (
                      <Stamp tone="late">void{t.voidReason ? `: ${t.voidReason}` : ''}</Stamp>
                    ) : (
                      <Button
                        size="sm"
                        tone="pink"
                        icon="undo"
                        onClick={() => {
                          const reason = prompt('Void this hand-over? Points, the free drink and the stock all come back. Reason (optional):');
                          if (reason !== null) act(() => api.post(`/api/stalls/admin/txns/${t.id}/void`, { reason: reason.trim() || undefined }, OkSchema));
                        }}
                      >
                        void
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function StallsConsole() {
  const q = useQuery({ queryKey: OV, queryFn: () => api.get('/api/stalls/admin/overview', AdminOverviewSchema), refetchInterval: 5000 });
  const act = useAct();
  const run = (f: () => Promise<unknown>) => act.mutate(f);
  useLiveEvent('stalls.voided', () => void q.refetch());
  if (q.isPending) return <LoadingState label="loading stalls..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const ov = q.data;
  return (
    <div className={ui.stack}>
      <Settings ov={ov} act={run} />
      {ov.stalls.filter((st) => st.active).length < 2 && <AddStall act={run} first title={ov.stalls.length === 0 ? 'add your stalls' : 'add the second stall'} />}
      {ov.stalls.length === 0 && (
        <Card tone="sun" tilt={0.4}>
          <div className={ui.row}>
            <Doodle name="star" size={34} fill="var(--paper-3)" />
            <p className={ui.hand}>no stalls yet. add one below, or paste the whole menu and the stalls appear with their codes.</p>
          </div>
        </Card>
      )}
      {ov.stalls.map((st) => (
        <StallBlock key={st.id} st={st} act={run} />
      ))}
      {ov.stalls.filter((st) => st.active).length >= 2 && <AddStall act={run} title="add another stall" />}
      <ImportCsv act={run} />
      <Transactions act={run} />
      <DangerZone act={run} />
    </div>
  );
}

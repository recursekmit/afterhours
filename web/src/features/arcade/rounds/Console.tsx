/*
  Console for the puzzle hour.
  - Rounds: release the next set by hand (the event can run late; nothing auto-advances). The button
    names the round it releases, so a double click can't release two.
  - Houses: standings, rename, assign by kit IDs, fill everyone without a house, and the
    extra-hint perk (one per house per round).
  - Mocktail bar: the exchange rate, a kit lookup and a claim button. Each lookup gets a fresh claim
    key, so a double press or a retried request hands over one mocktail.
  - Level stats and a typed-confirm reset for after the rehearsal.
*/
import {
  ClaimResponseSchema,
  type HouseStanding,
  type PersonLookup,
  PersonLookupSchema,
  PUZZLE_GAMES,
  RewardSettingsSchema,
  RoundsAdminSchema,
} from '@afterhours/shared/features/arcade-rounds';
import { OkSchema } from '@afterhours/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { api } from '../../../core/api';
import { useLiveEvent } from '../../../core/live';
import { fmtClock } from '../../../core/time';
import { Button, Doodle, TextArea, TextField, useToast } from '../../../kit';
import { Section, Stamp, Stat, ui } from '../../common/ui';
import { pressKey } from './useRounds';

const CONFIRM = 'RESET ROUNDS';
const AssignSchema = z.object({ assigned: z.number(), unknown: z.array(z.string()) });

export function RoundsConsole() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['arcade', 'rounds', 'admin'], queryFn: () => api.get('/api/arcade/rounds/admin', RoundsAdminSchema), refetchInterval: 5000 });
  const refresh = () => void q.refetch();
  useLiveEvent('arcade.houses', refresh);
  useLiveEvent('arcade.round', refresh);
  const opts = { onSuccess: refresh, onError: (e: Error) => toast(e.message, { kind: 'bad' }) };
  const d = q.data;
  const next = (d?.round ?? 0) + 1;

  const release = useMutation({
    mutationFn: (round: number) => api.post('/api/arcade/rounds/admin/release', { round }, z.object({ round: z.number() })),
    ...opts,
    onSuccess: (r) => (refresh(), toast(`round ${r.round} is out. phones got the news.`, { kind: 'good' })),
  });
  const perk = useMutation({ mutationFn: (b: { houseId: number; round: number }) => api.post('/api/arcade/rounds/admin/perk', b, OkSchema), ...opts });
  const fill = useMutation({
    mutationFn: () => api.post('/api/arcade/rounds/admin/houses/fill', {}, z.object({ assigned: z.number() })),
    ...opts,
    onSuccess: (r) => (refresh(), toast(`${r.assigned} people sorted into houses`, { kind: 'good' })),
  });

  return (
    <div className={ui.stack}>
      <Section title="puzzle hour" tape action={d && <Stamp tone={d.round > 0 ? 'live' : 'info'}>{d.round > 0 ? `round ${d.round} of ${d.maxRound}` : 'not started'}</Stamp>}>
        {d && !d.open && <p className={ui.hand}>the arcade is closed: players can finish what they started but can't open new levels. open it in the panel below.</p>}
        <div className={ui.statGrid}>
          <Stat label="round live" value={d?.round ?? '...'} />
          <Stat label="mocktails handed out" value={d?.claims.count ?? '...'} />
          <Stat label="people without a house" value={d?.unassigned ?? '...'} />
        </div>
        <div className={ui.row}>
          <Button tone="lime" size="lg" icon="play" disabled={!d || next > d.maxRound} loading={release.isPending} onClick={() => release.mutate(next)}>
            {d && next > d.maxRound ? 'all rounds are out' : `release round ${next}`}
          </Button>
          <span className={ui.hand}>
            {d?.released.length ? d.released.map((r) => `round ${r.round} at ${fmtClock(r.at)}`).join(', ') : 'aim for a fresh round every 15 to 20 minutes from 7 pm.'}
          </span>
        </div>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>round</th>
              <th>game</th>
              <th>level</th>
              <th>players</th>
              <th>cleared</th>
              <th>tries</th>
            </tr>
          </thead>
          <tbody>
            {d?.levels.map((l) => (
              <tr key={l.id} style={{ opacity: l.round > d.round ? 0.5 : 1 }}>
                <td className={ui.num}>{l.round}</td>
                <td>{PUZZLE_GAMES[l.game].title}</td>
                <td>
                  <b>{l.title}</b>
                </td>
                <td className={ui.num}>{l.players}</td>
                <td className={ui.num}>{l.clears}</td>
                <td className={ui.num}>{l.tries}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="houses" tilt={0.2} action={<Button size="sm" tone="sky" icon="users" loading={fill.isPending} disabled={!d?.unassigned} onClick={() => fill.mutate()}>{`sort ${d?.unassigned ?? 0} without a house`}</Button>}>
        <p className={ui.hand}>players can't pick or switch houses. moving someone keeps what they already earned with their old house.</p>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>house</th>
              <th>players</th>
              <th>points</th>
              <th>by round</th>
              <th>extra hint</th>
            </tr>
          </thead>
          <tbody>
            {d?.houses.map((h) => (
              <HouseRow key={h.id} h={h} round={d.round} max={d.maxRound} onPerk={(round) => perk.mutate({ houseId: h.id, round })} onSaved={refresh} />
            ))}
          </tbody>
        </table>
        {d && <AssignForm houses={d.houses} onDone={refresh} />}
      </Section>

      <MocktailBar rewards={d?.rewards} onChanged={refresh} />
      <ResetRounds onDone={refresh} />
    </div>
  );
}

function HouseRow({ h, round, max, onPerk, onSaved }: { h: HouseStanding; round: number; max: number; onPerk: (round: number) => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) => api.post(`/api/arcade/rounds/admin/houses/${h.id}`, { name: n }, OkSchema),
    onSuccess: () => (setName(null), onSaved()),
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  // The perk is for the next round; once everything is out, for the current one.
  const target = Math.min(round + 1, max);
  const has = h.perks.includes(target);
  return (
    <tr>
      <td className={ui.num}>{h.rank}</td>
      <td>
        <div className={ui.row} style={{ gap: 6 }}>
          <Doodle name={h.glyph} size={22} fill={`var(--${h.tone})`} />
          {name === null ? (
            <button type="button" className={ui.hand} style={{ background: 'none', border: 0, cursor: 'pointer', minHeight: 44 }} onClick={() => setName(h.name)} aria-label={`rename ${h.name}`}>
              <b>{h.name}</b> (rename)
            </button>
          ) : (
            <form
              className={ui.row}
              style={{ gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) save.mutate(name.trim());
              }}
            >
              <TextField label="house name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoFocus />
              <Button size="sm" tone="lime" type="submit" loading={save.isPending}>
                save
              </Button>
            </form>
          )}
        </div>
      </td>
      <td className={ui.num}>{h.members}</td>
      <td className={ui.num}>{h.points}</td>
      <td>{h.byRound.join(' / ')}</td>
      <td>
        {round === 0 ? (
          <span className={ui.hand}>after round 1</span>
        ) : has ? (
          <Stamp tone="live">round {target}</Stamp>
        ) : (
          <Button size="sm" tone="sun" icon="spark" onClick={() => onPerk(target)}>
            give for round {target}
          </Button>
        )}
      </td>
    </tr>
  );
}

function AssignForm({ houses, onDone }: { houses: HouseStanding[]; onDone: () => void }) {
  const toast = useToast();
  const [houseId, setHouseId] = useState(houses[0]?.id ?? 1);
  const [kits, setKits] = useState('');
  const assign = useMutation({
    mutationFn: () =>
      api.post(
        '/api/arcade/rounds/admin/houses/assign',
        {
          houseId,
          kitIds: kits
            .split(/[\s,;]+/)
            .map((k) => k.trim())
            .filter(Boolean),
        },
        AssignSchema,
      ),
    onSuccess: (r) => {
      toast(`${r.assigned} moved${r.unknown.length ? `. not signed in yet: ${r.unknown.join(', ')}` : ''}`, { kind: r.unknown.length ? 'info' : 'good' });
      setKits('');
      onDone();
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <div className={ui.stack}>
      <TextArea label="kit IDs to put in a house" hint="paste them separated by spaces, commas or new lines" value={kits} rows={2} onChange={(e) => setKits(e.target.value)} />
      <div className={ui.row}>
        <label className={ui.label}>
          house
          <select className={ui.select} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
            {houses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <Button tone="sky" icon="users" disabled={!kits.trim()} loading={assign.isPending} onClick={() => assign.mutate()}>
          assign
        </Button>
      </div>
    </div>
  );
}

function MocktailBar({ rewards, onChanged }: { rewards: { tokensPerClear: number; mocktailCost: number } | undefined; onChanged: () => void }) {
  const toast = useToast();
  const [rate, setRate] = useState<{ per: string; cost: string } | null>(null);
  const [kit, setKit] = useState('');
  const [person, setPerson] = useState<PersonLookup | null>(null);
  const [claimKey, setClaimKey] = useState(pressKey);
  const saveRate = useMutation({
    mutationFn: (b: { tokensPerClear: number; mocktailCost: number }) => api.post('/api/arcade/rounds/admin/rewards', b, RewardSettingsSchema),
    onSuccess: () => (setRate(null), onChanged(), toast('exchange rate saved', { kind: 'good' })),
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const look = useMutation({
    mutationFn: (k: string) => api.get(`/api/arcade/rounds/admin/person?kit=${encodeURIComponent(k)}`, PersonLookupSchema),
    onSuccess: (p) => (setPerson(p), setClaimKey(pressKey())),
    onError: (e: Error) => (setPerson(null), toast(e.message, { kind: 'bad' })),
  });
  const claim = useMutation({
    mutationFn: () => api.post('/api/arcade/rounds/admin/claim', { kitId: person!.kitId, key: claimKey }, ClaimResponseSchema),
    onSuccess: (r) => {
      setPerson(r.person);
      setClaimKey(pressKey());
      onChanged();
      toast(r.duplicate ? 'already handed over: that was the same press' : `one mocktail for ${r.person.nickname ?? r.person.kitId}`, { kind: r.duplicate ? 'info' : 'good' });
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const per = rate?.per ?? String(rewards?.tokensPerClear ?? '');
  const cost = rate?.cost ?? String(rewards?.mocktailCost ?? '');
  const canClaim = !!person && person.rewards.balance >= person.rewards.mocktailCost;
  return (
    <Section title="mocktail bar" tilt={-0.2}>
      <p className={ui.hand}>tokens come from first clears in the puzzle hour. a claim spends tokens only: scores and house totals don't move.</p>
      <div className={ui.row}>
        <TextField label="tokens per first clear" inputMode="numeric" value={per} onChange={(e) => setRate({ per: e.target.value, cost })} style={{ maxWidth: 140 }} />
        <TextField label="tokens per mocktail" inputMode="numeric" value={cost} onChange={(e) => setRate({ per, cost: e.target.value })} style={{ maxWidth: 140 }} />
        <Button tone="paper" disabled={!rate} loading={saveRate.isPending} onClick={() => saveRate.mutate({ tokensPerClear: Number(per), mocktailCost: Number(cost) })}>
          save rate
        </Button>
      </div>
      <form
        className={ui.row}
        onSubmit={(e) => {
          e.preventDefault();
          if (kit.trim()) look.mutate(kit.trim());
        }}
      >
        <TextField label="kit ID at the bar" value={kit} onChange={(e) => setKit(e.target.value)} placeholder="AH-042" />
        <Button tone="sky" icon="search" type="submit" loading={look.isPending}>
          look up
        </Button>
      </form>
      {person && (
        <div className={ui.stack}>
          <div className={ui.statGrid}>
            <Stat label={`${person.nickname ?? person.name ?? person.kitId}${person.house ? `, ${person.house.name}` : ''}`} value={`${person.rewards.balance} tokens`} />
            <Stat label="mocktails so far" value={person.claims.length} />
          </div>
          <Button tone="lime" size="lg" icon="ticket" disabled={!canClaim} loading={claim.isPending} onClick={() => claim.mutate()}>
            {canClaim ? `hand over a mocktail (${person.rewards.mocktailCost} tokens)` : `needs ${person.rewards.mocktailCost} tokens`}
          </Button>
        </div>
      )}
    </Section>
  );
}

function ResetRounds({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () => api.post('/api/arcade/rounds/admin/reset', { confirm: CONFIRM }, OkSchema),
    onSuccess: () => (setConfirm(''), onDone(), toast('puzzle hour wiped', { kind: 'good' })),
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <Section title="puzzle hour danger zone" tilt={0.2}>
      <p className={ui.hand}>for after the rehearsal: wipes released rounds, attempts, perks, mocktail claims and puzzle points. houses and the exchange rate stay.</p>
      <div className={ui.row}>
        <TextField label={`type ${CONFIRM}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button tone="pink" disabled={confirm !== CONFIRM} loading={reset.isPending} onClick={() => reset.mutate()}>
          reset puzzle hour
        </Button>
      </div>
    </Section>
  );
}

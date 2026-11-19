/*
  The puzzle-hour section at the top of /arcade:
  - round banner: which round is live, as a strip of round stamps;
  - your house and your mocktail tokens, side by side but never mixed;
  - three cabinets (packet panic, patch the bot, rebuild the image) with your progress;
  - the scoring rules, published.
  Plus the routes' page components and the live toasts for round drops and house perks.
*/
import { PUZZLE_GAMES, PUZZLE_IDS, type PuzzleId, ROUND_COUNT, type RoundsHub, RoundsHubSchema } from '@afterhours/shared/features/arcade-rounds';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../../core/api';
import { useLiveEvent } from '../../../core/live';
import { Card, Doodle, ErrorState, Meter, useToast } from '../../../kit';
import { Stamp, ui } from '../../common/ui';
import arcade from '../arcade.module.css';
import { PuzzlePage } from './Play';
import s from './rounds.module.css';
import { roundsKey, useRoundsHub } from './useRounds';

const TONE: Record<PuzzleId, string> = { packet: 'tone-sky', patch: 'tone-pink', pixels: 'tone-grape' };
const ICON = { packet: 'map', patch: 'robot', pixels: 'eye' } as const;

export const PacketPage = () => <PuzzlePage game="packet" />;
export const PatchPage = () => <PuzzlePage game="patch" />;
export const PixelsPage = () => <PuzzlePage game="pixels" />;

function RoundBanner({ d }: { d: RoundsHub }) {
  return (
    <Card tone="ink" tilt={-1} className={s.banner}>
      {d.round === 0 ? (
        <>
          <span className={s.bannerBig}>puzzle hour soon</span>
          <span className={s.bannerText}>levels drop in rounds once the organisers kick it off. we'll ping you.</span>
        </>
      ) : (
        <>
          <span className={s.bannerBig}>round {d.round} is live</span>
          <span className={s.bannerText}>
            {d.round < d.maxRound ? 'a fresh set drops every 15 to 20 minutes. old levels stay open.' : 'last round. everything is out, go get it.'}
          </span>
        </>
      )}
      <div className={s.dots} aria-label={`round ${d.round} of ${d.maxRound}`}>
        {Array.from({ length: d.maxRound }, (_, i) => (
          <span key={i} className={`${s.dot} ${i < d.round ? s.dotOn : ''} ${i + 1 === d.round ? s.dotNow : ''}`}>
            {i + 1}
          </span>
        ))}
      </div>
    </Card>
  );
}

function HouseCard({ d }: { d: RoundsHub }) {
  const h = d.house;
  if (!h)
    return (
      <Card tone="paper" tilt={0.8} className={s.houseCard}>
        <span className={s.houseKicker}>your house</span>
        <span className={s.houseName}>not sorted yet</span>
        <span className={ui.hand}>an organiser puts you in one of four houses. your points still count for you meanwhile.</span>
      </Card>
    );
  return (
    <Card tone={h.tone} tilt={0.8} tape="left" className={s.houseCard} aria-label={`your house: ${h.name}`}>
      <div className={s.houseTop}>
        <Doodle name={h.glyph} size={34} fill="var(--paper-3)" />
        <span className={s.houseName}>{h.name}</span>
      </div>
      <span className={s.houseKicker}>your house, #{h.rank} of 4</span>
      <span className={s.bigNum}>{h.points}</span>
      <span className={s.houseKicker}>
        house points from {h.members} {h.members === 1 ? 'player' : 'players'}. yours: {d.pointsEarned}.
      </span>
      {h.perks.includes(d.round) && <Stamp tone="ink">extra hint this round</Stamp>}
      {h.perks.includes(d.round + 1) && <Stamp tone="ink">extra hint next round</Stamp>}
    </Card>
  );
}

function TokenCard({ d }: { d: RoundsHub }) {
  const r = d.rewards;
  // Progress toward the next mocktail.
  const shown = Math.min(r.balance, r.mocktailCost);
  return (
    <Card tone="sun" tilt={-0.6} className={s.tokenCard} aria-label="your mocktail tokens">
      <span className={s.houseKicker}>your mocktail tokens</span>
      <div className={s.tokenRow}>
        <span className={s.bigNum}>{r.balance}</span>
        <div className={s.tokens} aria-hidden="true">
          {Array.from({ length: r.mocktailCost }, (_, i) => (
            <span key={i} className={`${s.token} ${i < shown ? '' : s.tokenEmpty}`}>
              {i < shown && <Doodle name="star" size={14} />}
            </span>
          ))}
        </div>
      </div>
      <span className={ui.hand}>
        {r.tokensPerClear} token{r.tokensPerClear === 1 ? '' : 's'} per first clear. {r.mocktailCost} tokens = one mocktail. spending them never touches your score or your house.
      </span>
      <span className={ui.hand}>
        at the bar, show kit <span className={s.kit}>{r.kitId}</span>
      </span>
    </Card>
  );
}

export function RoundsSection() {
  const q = useRoundsHub();
  if (q.isPending) return null;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <section className={ui.stack} aria-labelledby="puzzle-hour">
      <div className={s.sectionHead}>
        <h2 id="puzzle-hour" className={s.sectionTitle}>
          puzzle hour
        </h2>
        <span className={ui.hand}>{d.pointsLeft > 0 ? `${d.pointsLeft} pts on the table` : d.round > 0 ? 'all cleared. legend.' : ''}</span>
      </div>
      <RoundBanner d={d} />
      <div className={s.duo}>
        <HouseCard d={d} />
        <TokenCard d={d} />
      </div>
      {!d.open && <p className={arcade.off}>the arcade is closed right now.</p>}
      <div className={arcade.cabinets}>
        {PUZZLE_IDS.map((g, i) => {
          const info = PUZZLE_GAMES[g];
          const mine = d.levels.filter((l) => l.game === g);
          const done = mine.filter((l) => l.status === 'cleared').length;
          const fresh = mine.some((l) => l.round === d.round && l.status === 'new');
          const open = d.open && mine.length > 0;
          return (
            <Link
              key={g}
              to={open ? `/arcade/${g}` : '#'}
              className={`${arcade.cabinet} ${arcade[TONE[g]]} ${open ? '' : arcade.closed}`}
              style={{ rotate: `${i % 2 ? 1.5 : -1.5}deg` }}
              aria-disabled={!open}
            >
              <span className={arcade.marquee}>
                <Doodle name={ICON[g]} size={30} fill="var(--sun)" /> {info.title}
              </span>
              <span className={arcade.blurb}>{info.blurb}</span>
              <Meter value={done / ROUND_COUNT} tone="lime" label={`${info.title} levels cleared`} />
              <span className={s.cabProgress}>
                <span>
                  cleared <b>{done}</b> of {mine.length} out
                </span>
                <span>{mine.length < ROUND_COUNT ? `${ROUND_COUNT - mine.length} still locked` : 'all levels out'}</span>
              </span>
              {fresh && (
                <Stamp tone="live" className={s.newBadge}>
                  new level
                </Stamp>
              )}
            </Link>
          );
        })}
      </div>
      <Card tone="paper" tilt={0.4}>
        <details className={s.rules}>
          <summary>scoring rules</summary>
          <ol>
            {d.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </details>
      </Card>
    </section>
  );
}

/** Phone toasts: a round dropped; your house got a perk. Mounted with the arcade overlay. */
export function RoundToasts() {
  const toast = useToast();
  const qc = useQueryClient();
  useLiveEvent('arcade.round', (r) => toast(`fresh levels: ${r.titles.join(', ')}`, { kind: 'info', title: `round ${r.round} is out`, icon: 'gamepad', url: '/arcade', ms: 6000 }));
  useLiveEvent('arcade.perk', (p) => {
    // Only your own house's perk is news; look up your house when one lands.
    void qc
      .fetchQuery({ queryKey: roundsKey, queryFn: () => api.get('/api/arcade/rounds', RoundsHubSchema), staleTime: 0 })
      .then((d) => {
        if (d.house?.id === p.houseId) toast(`your house gets one extra hint each in round ${p.round}.`, { kind: 'good', title: 'house perk', icon: 'spark', url: '/arcade', ms: 6000 });
      })
      .catch(() => undefined);
  });
  return null;
}

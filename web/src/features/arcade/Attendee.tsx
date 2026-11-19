/*
  Arcade on the phone.
  - /arcade: a hub of three cabinets with your best, rank and points left today.
  - /arcade/:game: insert coin, play, then a result with count-up, new-best
    stamp, percentile and the daily cap meter.
  - "NEW #1" toast on arcade.record, wherever you are.
*/
import { ARCADE_DAILY_CAP, ARCADE_GAMES, type GameId, GameIdSchema, GamesResponseSchema, type RunResult, type RunStart, RunStartSchema } from '@afterhours/shared/features/arcade';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { celebrate } from '../../fun';
import { Button, Card, Doodle, EmptyState, ErrorState, LinkButton, LoadingState, Meter, NumberTicker, useToast } from '../../kit';
import { PageHead, Stamp, ui } from '../common/ui';
import s from './arcade.module.css';
import { BaseRush, Echo, GameTitle, LagSpike, StartButton } from './Games';
import { RoundsSection, RoundToasts } from './rounds/Hub';
import { useRoundsHub } from './rounds/useRounds';

export const gamesKey = ['arcade', 'games'] as const;
const TONE: Record<GameId, 'pink' | 'sky' | 'grape'> = { reaction: 'pink', hexbin: 'sky', memory: 'grape' };
const ICON: Record<GameId, 'bolt' | 'robot' | 'note'> = { reaction: 'bolt', hexbin: 'robot', memory: 'note' };

export function useGames() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: gamesKey, queryFn: () => api.get('/api/arcade/games', GamesResponseSchema), refetchInterval: 60_000 });
  useLiveEvent('arcade.toggled', () => void qc.invalidateQueries({ queryKey: gamesKey }));
  return q;
}

export function ArcadeHub() {
  const q = useGames();
  if (q.isPending) return <LoadingState label="plugging in the cabinets..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { settings, games, daily } = q.data;
  return (
    <div className={ui.page}>
      <PageHead title="arcade" note="puzzle hour levels drop in rounds. the quick games are always on, capped so they stay a side dish." color="var(--pink)" />
      <RoundsSection />
      <h2 className={s.quickTitle}>quick games</h2>
      <Card tone="ink" tilt={-1} className={s.cap}>
        <div className={ui.between}>
          <span className={s.capText}>quick game points today</span>
          <span className={s.capNum}>
            {daily.earned}/{daily.cap}
          </span>
        </div>
        <Meter value={daily.earned / Math.max(1, daily.cap)} tone="lime" label="daily arcade points" />
        <span className={s.capText}>{daily.remaining > 0 ? `${daily.remaining} pts left today` : 'capped for today. play for glory.'}</span>
      </Card>
      {!settings.enabled && <p className={s.off}>the arcade is closed right now.</p>}
      <div className={s.cabinets}>
        {games.map((g, i) => {
          const info = ARCADE_GAMES[g.id];
          const open = settings.enabled && settings.games[g.id] !== false;
          return (
            <Link key={g.id} to={open ? `/arcade/${g.id}` : '#'} className={`${s.cabinet} ${s[`tone-${TONE[g.id]}`]} ${open ? '' : s.closed}`} style={{ rotate: `${i % 2 ? 1.5 : -1.5}deg` }} aria-disabled={!open}>
              <span className={s.marquee}>
                <Doodle name={ICON[g.id]} size={30} fill="var(--sun)" /> {info.title}
              </span>
              <span className={s.blurb}>{info.blurb}</span>
              <span className={s.cabStats}>
                <span>
                  best <b>{g.best?.label ?? '-'}</b>
                </span>
                <span>{g.rank ? `#${g.rank} of ${g.players}` : `${g.players} playing`}</span>
              </span>
              {!open && <Stamp tone="done">closed</Stamp>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Result({ r, onAgain }: { r: RunResult; onAgain: () => void }) {
  useEffect(() => {
    if (r.newBest) celebrate({ y: 0.35 });
  }, [r.newBest]);
  return (
    <Card tone={r.newBest ? 'lime' : 'paper'} tilt={-1.2} tape className={s.result}>
      {r.newBest && (
        <Stamp tone="ink" rot={-10}>
          new best!
        </Stamp>
      )}
      <p className={s.resultNum}>
        <NumberTicker value={r.score} />
      </p>
      <p className={s.resultLabel}>{r.label}</p>
      <p className={ui.hand}>
        #{r.rank} of {r.players}, better than {r.percentile}% of players
      </p>
      <div className={`${ui.stack} ${s.wide}`}>
        <span className={ui.hand}>
          +{r.points} points{r.capReached ? ' (daily cap reached)' : `, ${r.capRemaining} left today`}
        </span>
        <Meter value={1 - r.capRemaining / ARCADE_DAILY_CAP} tone="lime" label="daily cap" />
      </div>
      <div className={ui.row}>
        <Button tone="ink" icon="undo" onClick={onAgain}>
          again
        </Button>
        <LinkButton to="/arcade" tone="paper" icon="gamepad">
          other games
        </LinkButton>
      </div>
    </Card>
  );
}

export function ArcadeGame() {
  const { game = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const parsed = GameIdSchema.safeParse(game);
  const [run, setRun] = useState<RunStart | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const start = useMutation({
    mutationFn: (g: GameId) => api.post('/api/arcade/runs', { game: g }, RunStartSchema),
    onSuccess: (r) => {
      setResult(null);
      setRun(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  if (!parsed.success) return <EmptyState title="no such game" hint="pick one from the arcade." mood="oops" />;
  const id = parsed.data;
  const done = (r: RunResult) => {
    setRun(null);
    setResult(r);
    void qc.invalidateQueries({ queryKey: gamesKey });
  };
  return (
    <div className={`${ui.page} ${s.play}`}>
      <Link to="/arcade" className={s.back}>
        <Doodle name="arrow" size={20} style={{ transform: 'rotate(180deg)' }} /> arcade
      </Link>
      <GameTitle game={id} />
      {result ? (
        <Result r={result} onAgain={() => start.mutate(id)} />
      ) : run ? (
        run.game === 'reaction' ? <LagSpike run={run} onDone={done} /> : run.game === 'hexbin' ? <BaseRush run={run} onDone={done} /> : <Echo run={run} onDone={done} />
      ) : (
        <StartButton onStart={() => start.mutate(id)} loading={start.isPending} />
      )}
    </div>
  );
}

export function ArcadeHomeCard() {
  const q = useGames();
  const rounds = useRoundsHub();
  const d = q.data;
  if (!d?.settings.enabled) return null;
  const r = rounds.data;
  return (
    <Card tone="grape" tilt={-1} tape="right" tapeColor="lime" className={s.homeCard}>
      <span className={s.homeKicker}>{r && r.round > 0 ? `puzzle hour: round ${r.round} is live` : 'arcade is open'}</span>
      <h3 className={s.homeTitle}>{r && r.round > 0 ? 'packet panic, patch the bot, rebuild the image' : 'lag spike, base rush, echo'}</h3>
      <span className={s.homeKicker}>{r && r.round > 0 ? `${r.pointsLeft} puzzle pts on the table` : `${d.daily.remaining} arcade pts left today`}</span>
      <LinkButton to="/arcade" tone="lime" size="sm" icon="gamepad">
        play
      </LinkButton>
    </Card>
  );
}

export function RecordToast() {
  const toast = useToast();
  useLiveEvent('arcade.record', (r) => toast(`${r.nickname} took #1 on ${ARCADE_GAMES[r.game].title}: ${r.label}`, { kind: 'info', title: 'NEW #1', icon: 'crown', url: '/arcade', ms: 5000 }));
  return null;
}

export function ArcadeOverlay() {
  return (
    <>
      <RecordToast />
      <RoundToasts />
    </>
  );
}

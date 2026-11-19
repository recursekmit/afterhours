/*
  /arcade/packet, /arcade/patch, /arcade/pixels: one puzzle game.
  - A strip of this game's levels: released ones (new / cleared / in progress), then locked rounds.
  - Opening a level starts an attempt, or resumes the one you left open, so a round
    release mid-run never swaps your puzzle.
  - The board sends tries with a fresh key per press. A dropped request is resent with the
    same key, so the server answers it once and never pays twice.
*/
import {
  type Attempt,
  HintResponseSchema,
  type LevelBody,
  LEVEL_POINTS,
  PUZZLE_GAMES,
  type PuzzleId,
  ROUND_COUNT,
  type StartAttemptResponse,
  TRY_GAP_MS,
  StartAttemptResponseSchema,
  type TryRequest,
  type TryResponse,
  TryResponseSchema,
} from '@afterhours/shared/features/arcade-rounds';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, isApiError } from '../../../core/api';
import { celebrate, haptics, sfx } from '../../../fun';
import { Button, Card, Doodle, EmptyState, ErrorState, LinkButton, LoadingState, NumberTicker, useToast } from '../../../kit';
import { Stamp, ui } from '../../common/ui';
import arcade from '../arcade.module.css';
import { BotBoard } from './BotBoard';
import { PacketBoard } from './PacketBoard';
import { PixelBoard } from './PixelBoard';
import s from './rounds.module.css';
import { pressKey, roundsKey, useRoundsHub } from './useRounds';

export type TryFn = (plan: TryRequest['plan']) => Promise<TryResponse>;
export interface BoardProps<G extends LevelBody['game']> {
  body: Extract<LevelBody, { game: G }>;
  attempt: Attempt;
  onTry: TryFn;
  busy: boolean;
  /** A new attempt id resets the board. */
  resetKey: string;
  onWin: (r: TryResponse) => void;
}

const attemptKey = (levelId: string) => ['arcade', 'attempt', levelId] as const;

export function PuzzlePage({ game }: { game: PuzzleId }) {
  const hub = useRoundsHub();
  const [params, setParams] = useSearchParams();
  const info = PUZZLE_GAMES[game];
  const levels = hub.data?.levels.filter((l) => l.game === game) ?? [];
  const picked = params.get('level');
  const levelId =
    (picked && levels.some((l) => l.id === picked) ? picked : null) ??
    levels.find((l) => l.inProgress)?.id ??
    levels.find((l) => l.status === 'new')?.id ??
    levels.at(-1)?.id ??
    null;

  return (
    <div className={`${ui.page} ${arcade.play}`}>
      <Link to="/arcade" className={arcade.back}>
        <Doodle name="arrow" size={20} style={{ transform: 'rotate(180deg)' }} /> arcade
      </Link>
      <div className={ui.stack}>
        <h2 className={arcade.gameTitle}>{info.title}</h2>
        <p className={ui.hand}>{info.howTo}</p>
      </div>
      {hub.isPending ? (
        <LoadingState label="booting the puzzle..." />
      ) : hub.isError ? (
        <ErrorState error={hub.error} onRetry={() => void hub.refetch()} />
      ) : levels.length === 0 ? (
        <EmptyState title="no levels out yet" hint="the organisers drop a fresh set every round. we'll ping you." mood="sleepy" />
      ) : (
        <>
          <nav className={s.levels} aria-label="levels">
            {levels.map((l, i) => (
              <button
                key={l.id}
                type="button"
                className={`${s.levelChip} ${l.id === levelId ? s.levelChipOn : ''}`}
                aria-pressed={l.id === levelId}
                onClick={() => setParams({ level: l.id }, { replace: true })}
              >
                <span className={s.levelNo}>
                  {i + 1}. {l.title}
                </span>
                <span className={s.levelSub}>{l.status === 'cleared' ? 'cleared, replay free' : l.inProgress ? `in progress, ${l.points} pts` : `${l.points} pts`}</span>
              </button>
            ))}
            {Array.from({ length: ROUND_COUNT - levels.length }, (_, i) => (
              <button key={`locked-${i}`} type="button" className={s.levelChip} disabled>
                <span className={s.levelNo}>
                  {levels.length + i + 1}. locked
                </span>
                <span className={s.levelSub}>round {levels.length + i + 1}, {LEVEL_POINTS[levels.length + i]} pts</span>
              </button>
            ))}
          </nav>
          {levelId && <LevelPlay key={levelId} levelId={levelId} game={game} nextId={levels[levels.findIndex((l) => l.id === levelId) + 1]?.id ?? null} />}
        </>
      )}
    </div>
  );
}

function LevelPlay({ levelId, game, nextId }: { levelId: string; game: PuzzleId; nextId: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const [win, setWin] = useState<TryResponse | null>(null);
  // Starting is idempotent on the server (it resumes an open attempt), so it can live in a query.
  const q = useQuery({
    queryKey: attemptKey(levelId),
    queryFn: () => api.post('/api/arcade/rounds/attempts', { levelId }, StartAttemptResponseSchema),
    staleTime: Infinity,
    gcTime: 0,
    retry: (n, e) => n < 2 && !isApiError(e, 'forbidden'),
  });
  const setAttempt = (a: Attempt) => qc.setQueryData<StartAttemptResponse>(attemptKey(levelId), (old) => (old ? { ...old, attempt: a } : old));

  const attempt = q.data?.attempt;
  const tryMut = useMutation({
    mutationFn: async (plan: TryRequest['plan']) => {
      const body = { key: pressKey(), plan };
      const url = `/api/arcade/rounds/attempts/${attempt!.id}/try`;
      try {
        return await api.post(url, body, TryResponseSchema);
      } catch (e) {
        // Flaky wifi, a server hiccup, or a press inside the try gap: send the very same request again.
        // Same key, so it is judged (and paid) once.
        if (!isApiError(e) || (e.status !== 0 && e.status !== 429 && e.status < 500)) throw e;
        await new Promise((ok) => setTimeout(ok, e.status === 429 ? TRY_GAP_MS + 100 : 900));
        return api.post(url, body, TryResponseSchema);
      }
    },
    onSuccess: (r) => {
      setAttempt(r.attempt);
      if (r.ok) void qc.invalidateQueries({ queryKey: roundsKey });
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad', title: 'try bounced' }),
  });
  const hint = useMutation({
    mutationFn: () => api.post(`/api/arcade/rounds/attempts/${attempt!.id}/hint`, {}, HintResponseSchema),
    onSuccess: (r) => setAttempt(r.attempt),
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });

  useEffect(() => setWin(null), [attempt?.id]);

  if (q.isPending) return <LoadingState label="loading the level..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { body, level } = q.data;
  const a = q.data.attempt;
  const onTry: TryFn = (plan) => tryMut.mutateAsync(plan);
  const props = { attempt: a, onTry, busy: tryMut.isPending, resetKey: a.id };

  return (
    <div className={ui.stack}>
      <div className={s.statusRow}>
        <span className={`${s.chip} ${s.chipInk}`}>round {a.round}</span>
        {a.mode === 'scored' ? (
          <span className={`${s.chip} ${s.chipLime}`}>{a.status === 'won' ? `paid ${a.paid} pts` : `worth ${a.worth} pts`}</span>
        ) : (
          <span className={`${s.chip} ${s.chipSun}`}>practice: no points</span>
        )}
        {a.fails > 0 && a.mode === 'scored' && a.status === 'open' && <span className={s.chip}>{a.fails} missed</span>}
        {a.hintAvailable && (
          <Button size="sm" tone="sun" icon="spark" loading={hint.isPending} onClick={() => hint.mutate()}>
            use house hint
          </Button>
        )}
      </div>
      {body.game === 'packet' && <PacketBoard {...props} body={body} onWin={setWin} />}
      {body.game === 'patch' && <BotBoard {...props} body={body} onWin={setWin} />}
      {body.game === 'pixels' && <PixelBoard {...props} body={body} onWin={setWin} />}
      {(win || a.status === 'won') && (
        <WinCard
          r={win}
          attempt={a}
          title={level.title}
          onReplay={() => {
            setWin(null);
            void qc.resetQueries({ queryKey: attemptKey(levelId) });
          }}
          nextHref={nextId ? `/arcade/${game}?level=${nextId}` : null}
          onNext={() => nextId && setParams({ level: nextId }, { replace: true })}
        />
      )}
    </div>
  );
}

function WinCard({ r, attempt, title, onReplay, nextHref, onNext }: { r: TryResponse | null; attempt: Attempt; title: string; onReplay: () => void; nextHref: string | null; onNext: () => void }) {
  const paid = r?.points ?? attempt.paid;
  useEffect(() => {
    if (!r) return;
    sfx.fanfare();
    haptics.celebrate();
    if (r.points > 0) celebrate({ y: 0.4 });
  }, [r]);
  return (
    <Card tone={paid > 0 ? 'lime' : 'paper'} tilt={-1.2} tape className={s.win}>
      <Stamp tone="ink" rot={-8}>
        cracked
      </Stamp>
      <p className={s.winLabel}>{title}</p>
      {attempt.mode === 'scored' ? (
        <>
          <p className={s.winNum}>
            +<NumberTicker value={paid} />
          </p>
          <p className={ui.hand}>
            points for you and your house{r && r.tokens > 0 ? `, plus ${r.tokens} mocktail token${r.tokens === 1 ? '' : 's'}` : ''}.
          </p>
        </>
      ) : (
        <p className={ui.hand}>practice run: no points, no tokens. still counts as bragging rights.</p>
      )}
      <div className={ui.row}>
        <Button tone="ink" icon="undo" onClick={onReplay}>
          replay
        </Button>
        {nextHref ? (
          <Button tone="sun" icon="play" onClick={onNext}>
            next level
          </Button>
        ) : (
          <LinkButton to="/arcade" tone="paper" icon="gamepad">
            arcade
          </LinkButton>
        )}
      </div>
    </Card>
  );
}

/*
  Scene host: renders registered projector scenes.
  - rotates through every scene whose useStatus() is not 'off' (each for its durationMs),
  - a 'takeover' scene jumps the queue and holds the screen while it stays takeover,
  - the console can pin one scene (screen.pinned), which beats everything.
  The core "join" scene is always first. Scenes size themselves with --u
  (1u = 1% of a 16:9 stage), e.g. font-size: calc(var(--u) * 4).
*/
import { ScreenStateSchema } from '@afterhours/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ComponentType, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../../core/api';
import type { SceneStatus } from '../../core/feature';
import { scenes as registered, screenOverlays } from '../../core/featureHost';
import { useLiveEvent } from '../../core/live';
import { qk } from '../../core/queries';
import { Doodle, LoadingState, RecurseLogo } from '../../kit';
import { JOIN_SCENE_ID, JoinScene } from './JoinScene';
import s from './screen.module.css';

interface Entry {
  id: string;
  label: string;
  Component: ComponentType;
  durationMs: number;
}

const JOIN: Entry = { id: JOIN_SCENE_ID, label: 'join', Component: JoinScene, durationMs: 15000 };

function Probe({ id, useStatus, report }: { id: string; useStatus: () => SceneStatus; report: (id: string, s: SceneStatus) => void }) {
  const status = useStatus();
  useEffect(() => {
    report(id, status);
  }, [id, status, report]);
  return null;
}

/** Each scene is printed on its feature's home ticket (docs/SPEC.md section 2). */
function scenePalette(id: string): string {
  if (/morse|slip/.test(id)) return 'armillary';
  if (/hunt|trail/.test(id)) return 'wave';
  if (/poll|schedule|attendance|checkin/.test(id)) return 'ginkgo';
  if (/arcade|drop|recap|leaderboard|reaction/.test(id)) return 'ruins';
  return 'wave';
}

export function SceneHost() {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const [statuses, setStatuses] = useState<Record<string, SceneStatus>>({});
  const [index, setIndex] = useState(0);
  const pin = useQuery({ queryKey: qk.screenState, queryFn: () => api.get('/api/screen/state', ScreenStateSchema) });
  useLiveEvent('screen.pinned', (d) => qc.setQueryData(qk.screenState, d));

  const report = useMemo(
    () => (id: string, st: SceneStatus) => setStatuses((m) => (m[id] === st ? m : { ...m, [id]: st })),
    [],
  );

  const entries = useMemo<Entry[]>(
    () => [JOIN, ...registered.map((sc) => ({ id: sc.id, label: sc.label, Component: sc.Component as ComponentType, durationMs: sc.durationMs ?? 15000 }))],
    [],
  );
  const live = entries.filter((e) => e.id === JOIN_SCENE_ID || (statuses[e.id] ?? 'available') !== 'off');
  const takeover = live.find((e) => statuses[e.id] === 'takeover');
  const pinned = pin.data?.pinned ? entries.find((e) => e.id === pin.data?.pinned) : undefined;
  const rotating = live[index % Math.max(1, live.length)] ?? JOIN;
  const current = pinned ?? takeover ?? rotating;
  const holding = Boolean(pinned ?? takeover);

  useEffect(() => {
    if (holding || live.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % live.length), current.durationMs);
    return () => window.clearTimeout(t);
  }, [holding, live.length, current.durationMs, current.id]);

  return (
    <div className={s.stage} data-palette={scenePalette(current.id)}>
      {registered.map((sc) => (sc.useStatus ? <Probe key={sc.id} id={sc.id} useStatus={sc.useStatus} report={report} /> : null))}
      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          className={s.scene}
          data-scene={current.id}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -24 }}
          transition={{ type: 'spring', stiffness: 220, damping: 26 }}
        >
          <Suspense fallback={<LoadingState label="loading scene..." />}>
            <current.Component />
          </Suspense>
        </motion.div>
      </AnimatePresence>

      <ol className={s.pager} aria-label="scenes">
        {live.map((e) => (
          <li key={e.id} className={`${s.pip} ${e.id === current.id ? s.pipOn : ''}`} title={e.label} />
        ))}
        {pinned && <Doodle name="pin" size={26} fill="var(--gold)" stroke="var(--gold-bright)" className={s.pinned} title="pinned by the console" />}
      </ol>

      {current.id !== JOIN_SCENE_ID && <RecurseLogo on="dark" height={44} className={s.bug} />}

      {screenOverlays.map((f) => (f.ScreenOverlay ? <f.ScreenOverlay key={f.name} /> : null))}
    </div>
  );
}

// The live status card: what is on the air, the numbers so far, and the buttons that matter.
import type { Control, LiveView } from '@afterhours/shared/features/quick';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '../../core/api';
import { Button, Card, Countdown, useToast } from '../../kit';
import { Stamp, Stat, ui } from '../common/ui';
import { StickerSheet } from '../hunt/Printables';
import { quickApi, qk, useSession } from './api';
import s from './quick.module.css';
import { templateInfo } from './templates';

const LABEL: Record<Control, string> = {
  close: 'close voting',
  reveal: 'reveal',
  next: 'next question',
  end: 'end now',
  extend: 'extend +1 min',
  undo: 'undo',
};
const TONE: Record<Control, 'lime' | 'sun' | 'pink' | 'paper' | 'sky' | 'tangerine'> = { close: 'sun', reveal: 'lime', next: 'lime', end: 'tangerine', extend: 'sky', undo: 'paper' };

export function useSessionActions(id: number) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: Control) => {
    if (busy) return;
    setBusy(true);
    try {
      const v = await quickApi.action(id, action);
      qc.setQueryData(qk.session(id), v);
      void qc.invalidateQueries({ queryKey: ['quick'] });
      if (action === 'undo') toast('taken back. nothing of it is left on phones or the projector.', { kind: 'info', title: 'undone' });
    } catch (e) {
      toast(isApiError(e) ? e.message : 'That did not work.', { kind: 'bad', title: 'not done' });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function Controls({ v, compact }: { v: LiveView; compact?: boolean }) {
  const { busy, run } = useSessionActions(v.session.id);
  return (
    <div className={compact ? s.controlsCompact : s.controls}>
      {v.controls.map((c) => (
        <Button key={c} type="button" tone={TONE[c]} ghost={c === 'undo'} size={compact ? 'sm' : 'md'} disabled={busy} onClick={() => void run(c)}>
          {LABEL[c]}
        </Button>
      ))}
    </div>
  );
}

function Bars({ v }: { v: LiveView }) {
  const max = Math.max(1, ...v.bars.map((b) => b.value));
  return (
    <ul className={s.bars} aria-label="results">
      {v.bars.map((b, i) => (
        <li key={i} className={b.mark ? s.barMark : undefined}>
          <span className={s.barLabel}>{b.label}</span>
          <span className={s.barTrack}>
            <span className={s.barFill} style={{ width: `${(100 * b.value) / max}%` }} />
          </span>
          <span className={s.barValue}>{b.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function LiveCard({ id, compact }: { id: number; compact?: boolean }) {
  const q = useSession(id);
  const [stickers, setStickers] = useState(false);
  const v = q.data;
  if (!v) return <Card tone="paper">loading...</Card>;
  const info = templateInfo(v.session.template);
  const done = v.phase === 'done' || v.session.status === 'ended' || v.session.status === 'undone';
  if (stickers && v.trailId !== null) return <StickerSheet trail={v.trailId} onClose={() => setStickers(false)} />;
  return (
    <Card tone={done ? 'paper' : info.tone} tilt={-0.3} className={s.liveCard} data-testid="live-card" data-phase={v.phase}>
      <div className={s.liveHead}>
        <Stamp tone={done ? 'done' : 'live'}>{done ? v.session.status === 'undone' ? 'taken back' : 'finished' : v.phase === 'queued' ? 'queued' : v.phase === 'live' ? 'live' : v.phase}</Stamp>
        <span className={s.liveKind}>{info.title}</span>
        {v.endsAt !== null && !done && (
          <span className={s.liveClock}>
            ends in <Countdown to={v.endsAt} />
          </span>
        )}
      </div>
      <h3 className={s.liveTitle}>{v.headline}</h3>
      {v.detail && <p className={ui.hand}>{v.detail}</p>}
      {v.code && (
        <div className={s.bigCode} aria-label="the code">
          {v.code}
        </div>
      )}
      {v.stats.length > 0 && (
        <div className={s.stats}>
          {v.stats.map((st) => (
            <Stat key={st.label} label={st.label} value={st.value} />
          ))}
        </div>
      )}
      {v.bars.length > 0 && <Bars v={v} />}
      {v.words.length > 0 && (
        <p className={s.words} aria-label="words">
          {v.words.map((w) => (
            <span key={w.word}>
              {w.word} <b>{w.count}</b>
            </span>
          ))}
        </p>
      )}
      {v.session.refs.displaced && <p className={ui.hand}>{v.session.refs.displaced}.</p>}
      {(v.session.refs.notes ?? []).map((n) => (
        <p key={n} className={s.note}>
          {n}
        </p>
      ))}
      {!compact && v.trailId !== null && (
        <Button type="button" tone="lime" icon="print" onClick={() => setStickers(true)}>
          print the QR stickers
        </Button>
      )}
      {v.session.status === 'queued' ? <QueuedControls id={v.session.id} /> : <Controls v={v} compact={compact} />}
    </Card>
  );
}

function QueuedControls({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { run } = useSessionActions(id);
  const [busy, setBusy] = useState(false);
  const launch = async (closeLive: boolean) => {
    setBusy(true);
    try {
      await quickApi.launch(id, closeLive);
      void qc.invalidateQueries({ queryKey: ['quick'] });
    } catch (e) {
      toast(isApiError(e) ? e.message : 'That did not work.', { kind: 'bad', title: 'not launched' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.controls}>
      <Button type="button" tone="lime" icon="bolt" disabled={busy} onClick={() => void launch(false)}>
        go live now
      </Button>
      <Button type="button" tone="paper" ghost disabled={busy} onClick={() => void launch(true)}>
        go live, closing what is on
      </Button>
      <Button type="button" tone="paper" ghost onClick={() => void run('undo')}>
        remove
      </Button>
    </div>
  );
}

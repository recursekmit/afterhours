/*
  Console: quick session. 1 pick a template, 2 fill a minimal form, 3 go live now or queue it.
  Above the gallery: what is on the air (with the controls that matter). Below: presets and history.
  `/admin/quick/speaker` is the phone view for a volunteer next to the speaker.
*/
import type { Overview, Preset, Session } from '@afterhours/shared/features/quick';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { isApiError } from '../../core/api';
import { Button, Card, Doodle, LoadingState, TextField, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import { newKey, quickApi, useOverview } from './api';
import { TemplateForm } from './Forms';
import { useFire } from './fire';
import { LiveCard } from './Live';
import s from './quick.module.css';
import Speaker from './Speaker';
import { type Draft, TEMPLATES, blankDraft, draftToCommon, draftToSpec, problemsOf, specToDraft, templateInfo } from './templates';

const SLOT: Record<string, 'poll' | 'drop' | 'morse' | null> = { poll: 'poll', wordcloud: 'poll', quiz: 'poll', code: 'drop', speed: 'drop', room: 'drop', morse: 'morse' };

export function whenText(t: number, now: number): string {
  const m = Math.round((now - t) / 60_000);
  return m <= 0 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function Gallery({ onPick }: { onPick: (id: Draft['template']) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = e.key === '0' ? 9 : Number(e.key) - 1;
      const t = TEMPLATES[i];
      if (t) onPick(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPick]);
  return (
    <ul className={s.gallery} aria-label="templates">
      {TEMPLATES.map((t, i) => (
        <li key={t.id}>
          <Card tone={t.tone} tilt={i % 2 ? 0.5 : -0.5} press className={s.tile} onClick={() => onPick(t.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(t.id))} aria-label={t.title}>
            <div className={s.tileHead}>
              <Doodle name={t.icon} size={30} />
              <span className={s.tileKey}>{i === 9 ? 0 : i + 1}</span>
            </div>
            <h3 className={s.tileTitle}>{t.title}</h3>
            <p className={s.tileSees}>{t.sees}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol className={s.steps} aria-label="steps">
      {['pick a template', 'fill it in', 'go live'].map((l, i) => (
        <li key={l} aria-current={at === i + 1 ? 'step' : undefined} className={at === i + 1 ? s.stepOn : at > i + 1 ? s.stepDone : undefined}>
          <span>{i + 1}</span> {l}
        </li>
      ))}
    </ol>
  );
}

function Composer({ initial, onClose, ov, presetId }: { initial: Draft; onClose: () => void; ov: Overview | undefined; presetId: number | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [presetName, setPresetName] = useState<string | null>(null);
  const key = useRef(newKey());
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const problems = useMemo(() => problemsOf(d), [d]);
  const info = templateInfo(d.template);
  const slot = SLOT[d.template] ?? null;
  const busyWith = slot ? ov?.busy[slot] : null;
  const spec = draftToSpec(d);

  const submit = async (closeLive: boolean, queue = false) => {
    setAttempted(true);
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setConflict(null);
    try {
      const body = { key: key.current, spec, common: draftToCommon(d), closeLive, presetId };
      if (queue) {
        await quickApi.queue(body);
        toast('queued. launch it from "on air" when the speaker asks.', { kind: 'info', title: 'saved for later' });
      } else {
        await quickApi.go(body);
        toast('live now. phones and the projector have it.', { kind: 'good', title: 'on the air' });
      }
      void qc.invalidateQueries({ queryKey: ['quick'] });
      onClose();
    } catch (e) {
      if (isApiError(e) && ['poll_live', 'drop_live', 'morse_live'].includes(e.code)) setConflict(e.message);
      else toast(isApiError(e) ? e.message : 'That did not work.', { kind: 'bad', title: 'not live' });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit(false);
      } else if (e.key === 'Escape' && !(document.querySelector('[role="dialog"]'))) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const savePreset = async () => {
    const name = (presetName ?? '').trim();
    if (!name) return;
    try {
      await quickApi.savePreset({ name, spec, common: draftToCommon(d) });
      void qc.invalidateQueries({ queryKey: ['quick'] });
      toast(`saved "${name}". fire it any time from presets.`, { kind: 'good', title: 'preset saved' });
      setPresetName(null);
    } catch (e) {
      toast(isApiError(e) ? e.message : 'Could not save.', { kind: 'bad', title: 'not saved' });
    }
  };

  const showProblems = attempted && problems.length > 0;
  return (
    <div className={ui.stack}>
      <Steps at={2} />
      <div className={s.composer}>
        <Section title={info.title} tilt={-0.3} action={<Button type="button" size="sm" tone="paper" ghost onClick={onClose}>back (esc)</Button>}>
          <p className={ui.hand}>{info.sees}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
            className={ui.stack}
          >
            <TemplateForm d={d} set={set} ov={ov} />
            {showProblems && (
              <ul className={s.problems} role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </form>
        </Section>
        <Section title="3. go live" tilt={0.3}>
          <TextField label="for which speaker or session" value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="Dr Rao's keynote" maxLength={60} hint="titles the run of show entry and the history" />
          {d.template !== 'checkin' && d.template !== 'announce' && (
            <label className={ui.toggle}>
              <input type="checkbox" checked={d.addToRunOfShow} onChange={(e) => set({ addToRunOfShow: e.target.checked })} />
              add to run of show
            </label>
          )}
          {d.addToRunOfShow && (
            <p className={s.warn}>
              {ov?.busy.activity ? `this starts it now and ends "${ov.busy.activity}" in the run of show.` : 'it starts in the run of show now.'}
            </p>
          )}
          {d.template !== 'announce' && (
            <>
              <label className={ui.toggle}>
                <input type="checkbox" checked={d.announce} onChange={(e) => set({ announce: e.target.checked })} />
                announce it (banner + push)
              </label>
              {d.announce && <TextField label="banner text" value={d.announceText} onChange={(e) => set({ announceText: e.target.value })} placeholder={`${info.title} live now!`} maxLength={200} />}
            </>
          )}
          {ov?.busy.pinned && <p className={s.note}>the projector is pinned to "{ov.busy.pinned}". it gets unpinned so this shows.</p>}
          {busyWith && !conflict && (
            <p className={s.warn}>
              {slot === 'poll' ? 'a poll is live' : slot === 'drop' ? 'a drop is live' : 'a speed round is running'}: "{busyWith}". you can close it as part of going live.
            </p>
          )}
          {conflict && (
            <div className={s.conflict} role="alert">
              <p>{conflict}</p>
              <Button type="button" tone="tangerine" disabled={busy} onClick={() => void submit(true)}>
                close it and launch this
              </Button>
            </div>
          )}
          <div className={s.goRow}>
            <Button type="button" tone="lime" size="lg" icon="bolt" loading={busy} onClick={() => void submit(false)}>
              go live now
            </Button>
            <Button type="button" tone="paper" onClick={() => void submit(false, true)} disabled={busy}>
              queue for later
            </Button>
          </div>
          <p className={ui.hand}>ctrl+enter goes live. {ov ? `${ov.present} signed in.` : ''}</p>
          {presetName === null ? (
            <Button type="button" tone="paper" ghost size="sm" onClick={() => setPresetName((d.question || d.huntTitle || d.annTitle || info.title).slice(0, 40))}>
              save as preset
            </Button>
          ) : (
            <div className={s.presetSave}>
              <TextField label="preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={60} />
              <Button type="button" tone="sky" size="sm" onClick={() => void savePreset()} disabled={!presetName.trim() || problems.length > 0}>
                save
              </Button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function PresetCards({ presets, ov, onOpen }: { presets: Preset[]; ov: Overview; onOpen: (p: Preset) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fire = useFire();
  const del = async (p: Preset) => {
    try {
      await quickApi.deletePreset(p.id);
      void qc.invalidateQueries({ queryKey: ['quick'] });
    } catch (e) {
      toast(isApiError(e) ? e.message : 'Could not delete.', { kind: 'bad' });
    }
  };
  void ov;
  return (
    <div className={ui.stack}>
      {fire.conflict && (
        <div className={s.conflict} role="alert">
          <p>{fire.conflict.message}</p>
          <Button
            type="button"
            tone="tangerine"
            onClick={() => {
              const id = Number(fire.conflict?.target.split(':')[1]);
              void fire.preset(id, undefined, true);
            }}
          >
            close it and launch this
          </Button>
        </div>
      )}
      <ul className={s.presets}>
        {presets.map((p) => {
          const info = templateInfo(p.template);
          return (
            <li key={p.id} className={s.presetRow}>
              <Doodle name={info.icon} size={22} />
              <span className={s.presetName}>{p.name}</span>
              <span className={s.presetKind}>{info.title}</span>
              <Button type="button" tone="lime" size="sm" icon="bolt" disabled={fire.pending !== null} onClick={() => void fire.preset(p.id)} aria-label={`fire ${p.name}`}>
                go live
              </Button>
              <Button type="button" tone="paper" size="sm" onClick={() => onOpen(p)} aria-label={`open ${p.name} in the form`}>
                edit
              </Button>
              {!p.builtin && (
                <Button type="button" tone="paper" size="sm" ghost onClick={() => void del(p)} aria-label={`delete ${p.name}`}>
                  delete
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function History({ rows, now, onDuplicate }: { rows: Session[]; now: number; onDuplicate: (s: Session) => void }) {
  const fire = useFire();
  if (rows.length === 0) return <p className={ui.hand}>nothing yet. the first thing you launch shows up here.</p>;
  return (
    <div className={ui.stack}>
      {fire.conflict && (
        <div className={s.conflict} role="alert">
          <p>{fire.conflict.message}</p>
          <Button type="button" tone="tangerine" onClick={() => void fire.rerun(Number(fire.conflict?.target.split(':')[1]), undefined, true)}>
            close it and launch this
          </Button>
        </div>
      )}
      <ul className={s.presets}>
        {rows.map((r) => (
          <li key={r.id} className={s.presetRow}>
            <Doodle name={templateInfo(r.template).icon} size={22} />
            <span className={s.presetName}>{r.title}</span>
            <span className={s.presetKind}>
              {r.status}, {whenText(r.liveAt ?? r.createdAt, now)}
            </span>
            <Button type="button" tone="lime" size="sm" icon="bolt" disabled={fire.pending !== null} onClick={() => void fire.rerun(r.id)} aria-label={`re-run ${r.title}`}>
              re-run
            </Button>
            <Button type="button" tone="paper" size="sm" onClick={() => onDuplicate(r)} aria-label={`duplicate ${r.title}`}>
              duplicate
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuickConsole() {
  const q = useOverview();
  const ov = q.data;
  const [draft, setDraft] = useState<{ d: Draft; presetId: number | null; nonce: number } | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const open = (d: Draft, presetId: number | null = null) => {
    setDraft({ d, presetId, nonce: Date.now() });
    topRef.current?.scrollIntoView?.({ block: 'start' });
  };
  if (!ov) return <LoadingState label="loading quick session..." />;
  const onAir = ov.live;
  return (
    <div className={ui.stack} ref={topRef}>
      {onAir.length > 0 && (
        <Section title="on air" tilt={0.2} action={<Stamp tone="live">{onAir.filter((x) => x.status === 'live').length} live</Stamp>}>
          <div className={s.onAir}>
            {onAir.map((x) => (
              <LiveCard key={x.id} id={x.id} />
            ))}
          </div>
        </Section>
      )}
      {draft ? (
        <Composer key={draft.nonce} initial={draft.d} ov={ov} presetId={draft.presetId} onClose={() => setDraft(null)} />
      ) : (
        <>
          <Steps at={1} />
          <p className={ui.hand}>
            the speaker wants something? pick it ({ov.present} signed in; points and winners are sized to the room). keys 1-9 and 0 pick a card.
          </p>
          <Gallery onPick={(id) => open(blankDraft(id, ov))} />
          <Section title="presets" tilt={-0.2} action={<Button type="button" size="sm" tone="paper" onClick={() => window.open('/admin/quick/speaker', '_blank')}>speaker view</Button>}>
            <PresetCards presets={ov.presets} ov={ov} onOpen={(p) => open(specToDraft(p.spec, p.common, ov), p.id)} />
          </Section>
          <Section title="history" tilt={0.2}>
            <History rows={ov.history} now={ov.serverNow} onDuplicate={(r) => open(specToDraft(r.spec, r.common, ov))} />
          </Section>
        </>
      )}
    </div>
  );
}

export default function QuickPanel() {
  const loc = useLocation();
  return loc.pathname.replace(/\/$/, '').endsWith('/speaker') ? <Speaker /> : <QuickConsole />;
}

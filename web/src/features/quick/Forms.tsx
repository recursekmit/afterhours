// One minimal form per template. Smart defaults are already in the draft; typing the question (or pasting
// the content) is usually all it takes.
import { type Overview, formatQuizPaste, parseHuntPaste, parseOptionsPaste, parseQuizPaste } from '@afterhours/shared/features/quick';
import { type ReactNode } from 'react';
import { Button, TextArea, TextField } from '../../kit';
import { ui } from '../common/ui';
import s from './quick.module.css';
import type { Draft } from './templates';

interface P {
  d: Draft;
  set: (patch: Partial<Draft>) => void;
  ov: Overview | undefined;
}

function Pills<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={s.pillField} role="radiogroup" aria-label={label}>
      <span className={s.fieldLabel}>{label}</span>
      <div className={s.pills}>
        {options.map((o) => (
          <Button key={String(o.id)} type="button" size="sm" tone={o.id === value ? 'ink' : 'paper'} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}>
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Num({ label, value, onChange, min, max, hint, suffix }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; hint?: ReactNode; suffix?: string }) {
  return (
    <TextField
      label={label}
      type="number"
      inputMode="numeric"
      value={Number.isFinite(value) ? String(value) : ''}
      min={min}
      max={max}
      suffix={suffix}
      hint={typeof hint === 'string' ? hint : undefined}
      onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
    />
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function PollForm({ d, set }: P) {
  const opts = parseOptionsPaste(d.optionsText);
  return (
    <div className={ui.stack}>
      <Pills
        label="kind"
        value={d.style}
        onChange={(style) => set({ style })}
        options={[
          { id: 'choice', label: 'pick one' },
          { id: 'this_or_that', label: 'this or that' },
          { id: 'rating', label: 'rating 1-5' },
        ]}
      />
      <TextField label="question" autoFocus value={d.question} onChange={(e) => set({ question: e.target.value })} placeholder="tabs or spaces?" maxLength={140} />
      {d.style === 'rating' ? (
        <Pills label="scale" value={d.ratingMax} onChange={(ratingMax) => set({ ratingMax })} options={[{ id: 5, label: '1 to 5' }, { id: 7, label: '1 to 7' }, { id: 10, label: '1 to 10' }]} />
      ) : (
        <TextArea
          label={d.style === 'this_or_that' ? 'the two sides, one per line' : 'options, one per line (paste a list)'}
          rows={4}
          value={d.optionsText}
          onChange={(e) => set({ optionsText: e.target.value })}
          placeholder={d.style === 'this_or_that' ? 'tabs\nspaces' : 'Python\nRust\nGo'}
          hint={`${count(opts.length, 'option')}. ${d.style === 'this_or_that' ? 'exactly 2' : '2 to 6'}.`}
        />
      )}
    </div>
  );
}

export function WordcloudForm({ d, set }: P) {
  return (
    <div className={ui.stack}>
      <TextField label="the prompt" autoFocus value={d.question} onChange={(e) => set({ question: e.target.value })} placeholder="one word for this talk" maxLength={140} />
      <Pills label="words each" value={d.maxWords} onChange={(maxWords) => set({ maxWords })} options={[{ id: 1, label: '1' }, { id: 2, label: '2' }, { id: 3, label: '3' }]} />
    </div>
  );
}

export function QuizForm({ d, set }: P) {
  const { questions, problems } = parseQuizPaste(d.quizText);
  const mark = (qi: number, oi: number) => set({ quizText: formatQuizPaste(questions.map((q, i) => (i === qi ? { ...q, correct: oi } : q))) });
  return (
    <div className={ui.stack}>
      <TextArea
        label="questions: a blank line between them, a * before the right answer"
        autoFocus
        rows={9}
        value={d.quizText}
        onChange={(e) => set({ quizText: e.target.value })}
        placeholder={'What does HTTP 404 mean?\n*not found\nforbidden\nteapot\n\nWhich command saves a commit?\n*git commit\ngit push'}
        spellCheck={false}
      />
      {questions.length > 0 && (
        <ol className={s.preview} aria-label="preview">
          {questions.map((q, qi) => (
            <li key={qi}>
              <strong>{q.question || '(no question yet)'}</strong>
              <div className={s.pills}>
                {q.options.map((o, oi) => (
                  <Button key={oi} type="button" size="sm" tone={oi === q.correct ? 'lime' : 'paper'} aria-pressed={oi === q.correct} onClick={() => mark(qi, oi)}>
                    {o}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
      {d.quizText.trim() && problems.length > 0 && (
        <ul className={s.problems} role="status">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className={s.twoCol}>
        <Num label="seconds per question" value={d.secondsPerQuestion} onChange={(n) => set({ secondsPerQuestion: n })} min={5} max={120} />
        <p className={ui.hand}>tap an option in the preview to mark it right. up to 5 questions. points: 20 plus up to 20 for speed.</p>
      </div>
    </div>
  );
}

export function CodeForm({ d, set, ov }: P) {
  return (
    <div className={ui.stack}>
      <TextField
        label="the code (blank: make one up)"
        autoFocus
        value={d.code}
        onChange={(e) => set({ code: e.target.value.toUpperCase() })}
        placeholder="SHIPIT"
        maxLength={12}
        hint="letters and digits. the projector shows it; phones type it."
      />
      <div className={s.twoCol}>
        <Num label="first winners" value={d.winners} onChange={(n) => set({ winners: n })} min={1} max={300} hint={ov ? `sized for ${ov.present} signed in` : undefined} />
        <Num label="window (seconds)" value={d.windowSec} onChange={(n) => set({ windowSec: n })} min={10} max={600} />
        <Num label="winner points" value={d.winPoints} onChange={(n) => set({ winPoints: n })} min={1} max={100} />
        <Num label="everyone else" value={d.restPoints} onChange={(n) => set({ restPoints: n })} min={0} max={50} />
      </div>
      <Pills label="shown as" value={d.display} onChange={(display) => set({ display })} options={[{ id: 'plain', label: 'plain code' }, { id: 'morse', label: 'morse to decode' }]} />
    </div>
  );
}

export function SpeedForm({ d, set }: P) {
  const choices = parseOptionsPaste(d.optionsText);
  return (
    <div className={ui.stack}>
      <TextField label="question" autoFocus value={d.question} onChange={(e) => set({ question: e.target.value })} placeholder="what does CSS stand for?" maxLength={140} />
      <TextArea label="choices, one per line (blank: a typed answer)" rows={3} value={d.optionsText} onChange={(e) => set({ optionsText: e.target.value, correct: null })} placeholder={'cascading style sheets\ncomputer style system'} />
      {choices.length >= 2 ? (
        <div className={s.pillField}>
          <span className={s.fieldLabel}>tap the right one</span>
          <div className={s.pills}>
            {choices.slice(0, 4).map((c, i) => (
              <Button key={i} type="button" size="sm" tone={d.correct === i ? 'lime' : 'paper'} aria-pressed={d.correct === i} onClick={() => set({ correct: i })}>
                {c}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <TextField label="accepted answers, comma separated" value={d.answersText} onChange={(e) => set({ answersText: e.target.value })} placeholder="cascading style sheets, css" />
      )}
      <div className={s.twoCol}>
        <Num label="window (seconds)" value={d.windowSec} onChange={(n) => set({ windowSec: n })} min={10} max={600} />
        <Num label="top points" value={d.topPoints} onChange={(n) => set({ topPoints: n })} min={1} max={100} />
      </div>
    </div>
  );
}

export function RoomForm({ d, set, ov }: P) {
  return (
    <div className={ui.stack}>
      <TextField label="what the room is doing" autoFocus value={d.roomTitle} onChange={(e) => set({ roomTitle: e.target.value })} maxLength={60} />
      <div className={s.twoCol}>
        <Num label="reactions needed" value={d.goal} onChange={(n) => set({ goal: n })} min={10} max={10000} hint={ov ? `sized for ${ov.present} signed in` : undefined} />
        <Num label="seconds" value={d.windowSec} onChange={(n) => set({ windowSec: n })} min={10} max={600} />
        <Num label="points each" value={d.points} onChange={(n) => set({ points: n })} min={1} max={50} />
      </div>
      <p className={ui.hand}>phones get a big react button. if the room hits the goal inside the clock, everyone gets the points.</p>
    </div>
  );
}

export function MorseForm({ d, set }: P) {
  return (
    <div className={ui.stack}>
      <Pills label="mode" value={d.morseMode} onChange={(morseMode) => set({ morseMode })} options={[{ id: 'decode', label: 'decode (listen, type)' }, { id: 'encode', label: 'encode (tap it out)' }]} />
      <Pills label="level" value={d.level} onChange={(level) => set({ level })} options={[1, 2, 3, 4, 5].map((n) => ({ id: n, label: String(n) }))} />
      <Num label="duration (seconds)" value={d.durationSec} onChange={(n) => set({ durationSec: n })} min={30} max={600} hint="podium pays 30 / 20 / 10 points, 5 for playing." />
    </div>
  );
}

export function CheckinForm({ d, set, ov }: P) {
  return (
    <div className={ui.stack}>
      <label className={ui.label}>
        which session
        <select className={ui.select} value={d.activityId ?? ''} onChange={(e) => set({ activityId: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">a new unplanned session (use the speaker name below)</option>
          {(ov?.activities ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} ({a.status})
            </option>
          ))}
        </select>
      </label>
      <Num label="auto-close after (minutes, 0 = stays open)" value={d.closeAfterMin} onChange={(n) => set({ closeAfterMin: n })} min={0} max={240} />
    </div>
  );
}

export function HuntForm({ d, set }: P) {
  const stops = parseHuntPaste(d.huntText);
  return (
    <div className={ui.stack}>
      <TextField label="name" autoFocus value={d.huntTitle} onChange={(e) => set({ huntTitle: e.target.value })} placeholder="lab 3 scavenger" maxLength={60} />
      <TextArea
        label="stops, one per line: clue => answer (no answer = a printed QR sticker)"
        rows={6}
        value={d.huntText}
        onChange={(e) => set({ huntText: e.target.value })}
        placeholder={'what runs when you type npm start? => node\nfind the sticker next to the projector'}
        spellCheck={false}
      />
      <ul className={s.preview} aria-label="stops">
        {stops.map((st, i) => (
          <li key={i}>
            <strong>stop {i + 1}</strong> {st.answer ? `riddle, answer "${st.answer}"` : 'QR sticker to find and scan'}
          </li>
        ))}
      </ul>
      <Num label="points per stop" value={d.pointsPerStop} onChange={(n) => set({ pointsPerStop: n })} min={1} max={50} hint="2 to 5 stops. after going live, print the stickers in one click." />
    </div>
  );
}

export function AnnounceForm({ d, set }: P) {
  return (
    <div className={ui.stack}>
      <TextField label="banner title" value={d.annTitle} onChange={(e) => set({ annTitle: e.target.value })} maxLength={60} />
      <TextField label="message" autoFocus value={d.annBody} onChange={(e) => set({ annBody: e.target.value })} placeholder="chai is out at the atrium" maxLength={200} />
      <label className={ui.toggle}>
        <input type="checkbox" checked={d.push} onChange={(e) => set({ push: e.target.checked })} />
        also send a push notification
      </label>
    </div>
  );
}

export function TemplateForm(p: P) {
  switch (p.d.template) {
    case 'poll':
      return <PollForm {...p} />;
    case 'wordcloud':
      return <WordcloudForm {...p} />;
    case 'quiz':
      return <QuizForm {...p} />;
    case 'code':
      return <CodeForm {...p} />;
    case 'speed':
      return <SpeedForm {...p} />;
    case 'room':
      return <RoomForm {...p} />;
    case 'morse':
      return <MorseForm {...p} />;
    case 'checkin':
      return <CheckinForm {...p} />;
    case 'hunt':
      return <HuntForm {...p} />;
    case 'announce':
      return <AnnounceForm {...p} />;
  }
}

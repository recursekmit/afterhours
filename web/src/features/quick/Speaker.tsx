/*
  Speaker view (/admin/quick/speaker): phone-sized and stripped down. A volunteer next to the speaker taps a
  preset and it is live; the controls for whatever is on the air sit at the top. Uses the console session.
*/
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Doodle, LoadingState, TextField } from '../../kit';
import { ui } from '../common/ui';
import { useOverview } from './api';
import { useFire } from './fire';
import { LiveCard } from './Live';
import s from './quick.module.css';
import { templateInfo } from './templates';

const STORE = 'quick.speaker.label';
const read = (): string => {
  try {
    return localStorage.getItem(STORE) ?? '';
  } catch {
    return '';
  }
};

export default function Speaker() {
  const q = useOverview();
  const ov = q.data;
  const [label, setLabel] = useState(read);
  const fire = useFire();
  const setL = (v: string) => {
    setLabel(v);
    try {
      localStorage.setItem(STORE, v);
    } catch {
      /* private window: the name just is not remembered */
    }
  };
  const live = ov?.live.filter((x) => x.status === 'live') ?? [];
  return (
    <div className={s.speaker} data-testid="speaker-view">
      <header className={s.speakerHead}>
        <h1 className={s.speakerTitle}>speaker view</h1>
        <Link to="/admin/quick" className={s.speakerBack}>
          console
        </Link>
      </header>
      {!ov ? (
        <LoadingState label="loading..." />
      ) : (
        <>
          <TextField label="who is on stage" value={label} onChange={(e) => setL(e.target.value)} placeholder="Dr Rao" maxLength={60} />
          {live.length > 0 && (
            <section className={ui.stack} aria-label="on air">
              {live.map((x) => (
                <LiveCard key={x.id} id={x.id} compact />
              ))}
            </section>
          )}
          {fire.conflict && (
            <div className={s.conflict} role="alert">
              <p>{fire.conflict.message}</p>
              <Button
                type="button"
                tone="tangerine"
                block
                onClick={() => void fire.preset(Number(fire.conflict?.target.split(':')[1]), label.trim() || undefined, true)}
              >
                close it and launch this
              </Button>
              <Button type="button" tone="paper" ghost block onClick={fire.clearConflict}>
                never mind
              </Button>
            </div>
          )}
          <ul className={s.speakerList} aria-label="presets">
            {ov.presets.map((p) => (
              <li key={p.id}>
                <Button type="button" tone={templateInfo(p.template).tone} size="lg" block disabled={fire.pending !== null} onClick={() => void fire.preset(p.id, label.trim() || undefined)} aria-label={`fire ${p.name}`}>
                  <span className={s.speakerBtn}>
                    <Doodle name={templateInfo(p.template).icon} size={26} />
                    {p.name}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/*
  The constellation map: six stars, one per trial, joined by a line of light as trials are sealed.
  Sealed stars sit on a red wax drop with their rhythm pips; the current star breathes; the rest wait faint.
*/
import { type Star, TRIALS, TRIAL_INFO } from '@afterhours/shared/features/cipher';
import s from './cipher.module.css';

const POS: [number, number][] = [
  [28, 128],
  [76, 56],
  [128, 112],
  [176, 40],
  [222, 106],
  [268, 46],
  [314, 112],
];

const star4 = (x: number, y: number, r: number) =>
  `M${x} ${y - r}L${x + r * 0.22} ${y - r * 0.22}L${x + r} ${y}L${x + r * 0.22} ${y + r * 0.22}L${x} ${y + r}L${x - r * 0.22} ${y + r * 0.22}L${x - r} ${y}L${x - r * 0.22} ${y - r * 0.22}Z`;

export function Constellation({ stars, current, onPick }: { stars: Star[]; current: number; onPick?: (trial: number) => void }) {
  return (
    <figure className={s.constellation} aria-label={`constellation: ${stars.filter((x) => x.sealedAt).length} of 7 trials sealed`}>
      <svg viewBox="0 0 340 170" role="img">
        {POS.slice(1).map(([x, y], i) => {
          const [px, py] = POS[i] as [number, number];
          const lit = Boolean(stars[i + 1]?.sealedAt) || (Boolean(stars[i]?.sealedAt) && i + 2 === current);
          return <line key={i} x1={px} y1={py} x2={x} y2={y} className={lit ? s.cLineLit : s.cLine} />;
        })}
        {POS.map(([x, y], i) => {
          const st = stars[i];
          const sealed = Boolean(st?.sealedAt);
          const isCur = i + 1 === current;
          return (
            <g
              key={TRIALS[i]}
              className={`${s.cStar} ${sealed ? s.cSealed : isCur ? s.cCurrent : s.cWaiting}`}
              data-testid={`star-${TRIALS[i]}`}
              data-sealed={sealed ? 'yes' : 'no'}
              onClick={() => onPick?.(i + 1)}
            >
              {sealed && <circle cx={x} cy={y} r={15} className={s.cWax} />}
              {isCur && <circle cx={x} cy={y} r={19} className={s.cHalo} />}
              <path d={star4(x, y, sealed ? 13 : isCur ? 12 : 9)} className={s.cShape} />
              <text x={x} y={y + 31} textAnchor="middle" className={s.cLabel}>
                {TRIAL_INFO[TRIALS[i]!].title.replace('the ', '')}
              </text>
              {sealed && (
                <g>
                  {[0, 1, 2].map((k) => (
                    <circle key={k} cx={x - 8 + k * 8} cy={y + 39} r={2.4} className={k < (st?.stars ?? 0) ? s.cPipOn : s.cPipOff} />
                  ))}
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/*
  Projector: the guild race (four bars, cipher points per member), the heat on each of the seven trials,
  and the pacts sealed ticker. Big enough to read from the back of a hall.
*/
import { GUILD_INFO, TRIALS, TRIAL_INFO } from '@afterhours/shared/features/cipher';
import { motion } from 'motion/react';
import { useCipherScreen } from './api';
import s from './cipher.module.css';

export default function CipherScene() {
  const q = useCipherScreen();
  const o = q.data;
  if (!o) return null;
  const max = Math.max(1, ...o.guilds.map((g) => g.average));
  const heatMax = Math.max(1, ...o.onTrial);
  return (
    <div className={s.scene} data-testid="cipher-scene">
      <div className={s.sceneHead}>
        <h2 className={s.sceneTitle}>the cipher: the guild race</h2>
        <span className={s.sceneNote}>{o.players} sworn in. points per member, so every guild has a chance.</span>
      </div>
      <div className={s.race}>
        {o.guilds.map((g) => {
          const info = GUILD_INFO[g.guild];
          return (
            <div key={g.guild} className={`${s.raceRow} ${g.rank === 1 && g.average > 0 ? s.raceLead : ''}`} data-guild={g.guild} data-testid={`race-${g.guild}`}>
              <span className={s.raceName}>
                <span className={s.raceSwatch} aria-hidden="true" />
                <span>
                  {info.short}
                  <small>
                    {g.members} {g.members === 1 ? 'member' : 'members'}, {info.colour}
                  </small>
                </span>
              </span>
              <div className={s.raceTrack}>
                <motion.div className={s.raceBar} initial={false} animate={{ width: `${Math.max(2, (g.average / max) * 100)}%` }} transition={{ type: 'spring', stiffness: 80, damping: 18 }} />
              </div>
              <span className={s.raceNum}>{g.average.toFixed(1)}</span>
            </div>
          );
        })}
      </div>
      <div className={s.side}>
        <div>
          <h3 className={s.boxTitle}>on each trial now</h3>
          <div className={s.heat}>
            {TRIALS.map((t, i) => (
              <div key={t} className={s.heatCol}>
                <motion.div className={s.heatBar} initial={false} animate={{ height: `${((o.onTrial[i] ?? 0) / heatMax) * 100}%` }} />
                <span className={s.heatNum}>{o.onTrial[i] ?? 0}</span>
                <span className={s.heatLabel}>{TRIAL_INFO[t].title.replace('the ', '')}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={s.ticker}>
          <span className={s.tickerHead}>{o.pactsSealed} pacts sealed</span>
          {o.recentPacts.slice(0, 4).map((p) => (
            <span key={`${p.a}-${p.b}-${p.at}`} className={s.tickerItem}>
              {p.a} and {p.b} ({GUILD_INFO[p.ga].short}, {p.gb ? GUILD_INFO[p.gb].short : 'the oracle'})
            </span>
          ))}
          {o.recentPacts.length === 0 && <span className={s.tickerItem}>{o.sealed[TRIALS.length - 2] ? '' : 'the first pact is still to come.'}</span>}
        </div>
      </div>
    </div>
  );
}

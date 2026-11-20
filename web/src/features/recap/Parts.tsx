/*
  Recap: the home card (a teaser while locked, "your story is ready" once open), the console panel
  (recap open switch, room totals, a phone-frame preview of anyone's recap) and the projector's room recap.
*/
import { PERSONALITIES, type RoomRecap } from '@afterhours/shared/features/recap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { SceneStatus } from '../../core/feature';
import { useMe } from '../../core/queries';
import { Avatar, Button, Card, Doodle, ErrorState, LoadingState, Sticker, TextField, useToast } from '../../kit';
import { Section, Stamp, ui } from '../common/ui';
import { CountUp } from './CountUp';
import { PersonalityDoodle } from './Doodles';
import { StoryView } from './Story';
import { recapApi, rk, useMyRecap, useRecapStatus, useRoomRecap } from './api';
import s from './recap.module.css';

export function RecapHomeCard() {
  const status = useRecapStatus();
  const open = status.data?.open ?? false;
  const me = useMyRecap(open);
  const avatar = useMe().data?.attendee?.avatar;
  if (!status.data) return null;
  if (!open) {
    if (!status.data.closing) return null;
    return (
      <Card tone="grape" tilt={0.6}>
        <div className={s.teaser}>
          <Doodle name="spark" size={40} fill="var(--sun)" />
          <p className={s.teaserText}>your after hours recap unlocks right after the final reveal. eyes on the big screen.</p>
        </div>
      </Card>
    );
  }
  const p = me.data ? PERSONALITIES[me.data.personality.id] : null;
  return (
    <Link to="/recap" className={s.homeLink} aria-label="watch your after hours recap">
      <Card tone="grape" tilt={-0.8} tape tapeColor="sun">
        <div className={s.home}>
          <div className={s.homeTop}>
            <div>
              <h3 className={s.homeTitle}>your recap is ready</h3>
              <p className={s.homeNote}>{p ? `spoiler: you're ${p.title}.` : 'your whole afternoon, story style.'} tap to watch.</p>
            </div>
            <span className={s.homeAvatar}>{p ? <PersonalityDoodle id={p.id} size={70} /> : <Avatar config={avatar} size={64} />}</span>
          </div>
          <div className={s.homeBars} aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
      </Card>
    </Link>
  );
}

function RoomTiles({ room, big = false }: { room: RoomRecap; big?: boolean }) {
  const tiles = [
    { n: room.attendees, label: 'people came', tone: 'lime' },
    { n: room.checkins, label: 'check-ins', tone: 'sun' },
    { n: room.votes, label: 'votes', tone: 'pink' },
    { n: room.stamps, label: 'trail stamps', tone: 'tangerine' },
    { n: room.morseLetters, label: 'morse letters', tone: 'sky' },
    { n: room.reactions, label: 'reactions', tone: 'grape' },
    { n: room.stickers, label: 'stickers stuck', tone: 'paper' },
    { n: room.points, label: 'points earned', tone: 'lime' },
  ];
  if (!big) {
    return (
      <div className={s.roomGrid}>
        {tiles.map((t) => (
          <div key={t.label} className={ui.stat}>
            <span className={ui.statNum}>{t.n.toLocaleString('en-IN')}</span>
            <span className={ui.statLabel}>{t.label}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={s.tiles}>
      {tiles.slice(0, 6).map((t, i) => (
        <div key={t.label} className={`${s.tile} ${s[`t-${t.tone}`] ?? ''}`}>
          <span className={s.tileNum}>
            <CountUp value={t.n} delay={300 + i * 250} format={(v) => Math.round(v).toLocaleString('en-IN')} />
          </span>
          <span className={s.tileLabel}>{t.label}</span>
        </div>
      ))}
    </div>
  );
}

export function useRecapSceneStatus(): SceneStatus {
  const st = useRecapStatus();
  return st.data?.open ? 'available' : 'off';
}

export default function RecapScene() {
  const q = useRoomRecap(15_000);
  const reduce = useReducedMotion();
  if (!q.data) return null;
  const room = q.data;
  return (
    <div className={s.scene}>
      <div className={s.sceneHead}>
        <h1 className={s.sceneTitle}>the room's after hours</h1>
        <span className={s.sceneHand}>open the app: your own recap is waiting</span>
      </div>
      <RoomTiles room={room} big />
      {room.rarest ? (
        <motion.div className={s.rare} initial={reduce ? false : { rotate: 8, scale: 0.8, opacity: 0 }} animate={{ rotate: -2, scale: 1, opacity: 1 }} transition={{ delay: 1.6, type: 'spring', stiffness: 200, damping: 14 }}>
          <span className={s.rareKicker}>rarest sticker of the day</span>
          <Sticker def={room.rarest.sticker} size={150} tilt={-8} slap />
          <span className={s.rareTitle}>{room.rarest.sticker.title}</span>
          <span className={s.rarePct}>only {room.rarest.pct}% have it</span>
          <ul className={s.holders}>
            {room.rarest.holders.slice(0, 5).map((h) => (
              <li key={h.nickname} className={s.holder}>
                <Avatar config={h.avatar} size={48} />
                <span>{h.nickname}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      ) : (
        <div />
      )}
    </div>
  );
}

export function RecapConsole() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useRecapStatus();
  const room = useRoomRecap(10_000);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const list = useQuery({ queryKey: rk.attendees(q), queryFn: () => recapApi.attendees(q) });
  const preview = useQuery({ queryKey: rk.preview(pick ?? 0), queryFn: () => recapApi.preview(pick ?? 0), enabled: pick !== null });
  const toggle = useMutation({
    mutationFn: (open: boolean) => recapApi.open(open),
    onSuccess: (d) => {
      qc.setQueryData(rk.status, d);
      toast(d.open ? 'recaps are open on every phone' : 'recaps closed', { kind: 'good' });
    },
    onError: (e: Error) => toast(e.message, { kind: 'bad' }),
  });
  const st = status.data;
  return (
    <div className={s.consoleGrid}>
      <div className={s.consoleCol}>
        <Section title="recap" tape action={st && <Stamp tone={st.open ? 'live' : 'done'}>{st.open ? 'open' : 'locked'}</Stamp>}>
          <div className={s.switch}>
            <span className={s.switchState}>{st?.open ? (st.reason === 'reveal' ? 'open (the reveal finished)' : 'open') : 'locked'}</span>
            <Button tone={st?.consoleOpen ? 'pink' : 'lime'} icon={st?.consoleOpen ? 'lock' : 'play'} loading={toggle.isPending} onClick={() => toggle.mutate(!st?.consoleOpen)}>
              {st?.consoleOpen ? 'close recaps' : 'open recaps now'}
            </Button>
          </div>
          <p className={s.note}>recaps open by themselves when the leaderboard's top-10 reveal finishes. open them early here (say, for the last 10 minutes), or close them again.</p>
        </Section>
        <Section title="the room, so far" tilt={0.2}>
          {room.data ? <RoomTiles room={room.data} /> : room.isError ? <ErrorState error={room.error} /> : <LoadingState label="counting..." />}
          <p className={s.note}>the projector's "room recap" scene shows this while recaps are open. pin it from the projector panel.</p>
        </Section>
        <Section title="preview someone's recap" tilt={-0.2}>
          <TextField label="find by kit or nickname" value={q} onChange={(e) => setQ(e.target.value)} placeholder="AH-042" />
          <div className={s.pick}>
            {list.data?.attendees.slice(0, 16).map((a) => (
              <Button key={a.id} size="sm" tone={pick === a.id ? 'ink' : 'paper'} onClick={() => setPick(a.id)}>
                {a.nickname ?? a.kitId} <span className={ui.hand}>{a.total}</span>
              </Button>
            ))}
          </div>
          {preview.data && (
            <p className={s.working}>
              personality working: {Object.entries(preview.data.personality.scores)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}
            </p>
          )}
        </Section>
      </div>
      <div>
        {pick === null ? (
          <div className={s.previewEmpty}>
            <p className={s.note}>pick someone to see their story exactly as their phone will.</p>
          </div>
        ) : preview.data ? (
          <StoryView key={pick} recap={preview.data} preview />
        ) : preview.isError ? (
          <ErrorState error={preview.error} />
        ) : (
          <LoadingState label="building their recap..." />
        )}
      </div>
    </div>
  );
}

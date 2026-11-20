/*
  Alerts on the phone:
  - BannerOverlay: every 'alerts.banner' arrives as a sealed letter: the wax seal cracks, the letter unfolds,
    and tapping it opens its url.
    On load, /recent fills in what was missed while offline (once each).
  - PushCard: the friendly "ping me before the big stuff" opt-in on home, with
    a test push, and the iPhone Add-to-Home-Screen explainer when needed.
*/
import { type Banner, RecentBannersResponseSchema, TestPushResponseSchema } from '@afterhours/shared/features/alerts';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../core/api';
import { serverNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { InstallHelp, isIOS, isStandalone } from '../../core/pwa/install';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, useToast, WaxSeal } from '../../kit';
import { ui } from '../common/ui';
import s from './alerts.module.css';
import { enablePush, isSubscribed, pushPermission, pushSupported } from './push';

const SEEN_KEY = 'ah:alerts-seen';
const PUSH_DISMISS = 'ah:push-dismissed';

function readNum(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
function writeNum(key: string, n: number): void {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* private mode */
  }
}

const BANNER_MS = 7000;
const TAPE_TONE: Record<Banner['kind'], string> = { soon: s.tapeSun ?? '', live: s.tapeLime ?? '', announcement: s.tapePink ?? '' };

/** A sealed letter that drops in, cracks its seal and unfolds; can be swiped away, and drains while it waits. */
function TapeBanner({ b, onGone }: { b: Banner; onGone: () => void }) {
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (hold) return;
    const t = window.setTimeout(onGone, BANNER_MS);
    return () => window.clearTimeout(t);
  }, [hold, onGone]);
  const open = b.url !== '/' ? b.url : null;
  return (
    <motion.div
      className={`${s.banner} ${TAPE_TONE[b.kind]}`}
      data-ground="parchment"
      role="status"
      style={{ transformOrigin: '50% 0%' }}
      initial={reduce ? { opacity: 0 } : { y: -60, scaleY: 0.18, opacity: 0 }}
      animate={{ y: 0, x: 0, scaleY: 1, opacity: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 260, transition: { duration: 0.22 } }}
      transition={reduce ? { duration: 0.2 } : { y: { type: 'spring', stiffness: 380, damping: 24 }, opacity: { duration: 0.15 }, scaleY: { delay: 0.35, type: 'spring', stiffness: 260, damping: 22 } }}
      drag={reduce ? 'x' : true}
      dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
      dragElastic={0.9}
      onDragStart={() => setHold(true)}
      onDragEnd={(_, i) => {
        if (Math.abs(i.offset.x) > 70 || i.offset.y < -40 || Math.abs(i.velocity.x) > 500) onGone();
        else setHold(false);
      }}
      whileDrag={{ scale: 1.02 }}
    >
      <span className={s.bannerIcon} aria-hidden="true">
        <WaxSeal glyph={b.kind === 'announcement' ? 'megaphone' : 'bell'} size={52} seed={b.id} />
        <svg className={s.crack} viewBox="0 0 52 52">
          <path d="M27 4L23 15L29 22L22 31L28 39L24 48" pathLength={100} />
        </svg>
      </span>
      <button
        type="button"
        className={s.bannerText}
        onClick={() => {
          if (open) navigate(open);
          onGone();
        }}
      >
        <span className={s.bannerTitle}>{b.title}</span>
        <span className={s.bannerBody}>{b.body}</span>
        {open && <span className={s.bannerGo}>tap to open</span>}
      </button>
      <button type="button" className={s.bannerX} aria-label="dismiss" onClick={onGone}>
        <Doodle name="close" size={22} stroke="currentColor" />
      </button>
      <span className={s.drain} style={{ animationDuration: `${BANNER_MS}ms`, animationPlayState: hold ? 'paused' : 'running' }} aria-hidden="true" />
    </motion.div>
  );
}

export function BannerOverlay() {
  const [current, setCurrent] = useState<Banner | null>(null);
  const clear = useCallback(() => setCurrent(null), []);
  const show = (b: Banner) => {
    setCurrent(b);
    sfx.note(880, 80, 'square');
    window.setTimeout(() => sfx.note(1320, 140, 'triangle'), 90);
    haptics.celebrate();
  };

  useLiveEvent('alerts.banner', (b) => {
    const seen = readNum(SEEN_KEY) ?? 0;
    if (b.id <= seen) return;
    writeNum(SEEN_KEY, b.id);
    show(b);
  });

  // Catch up once per load: banners from the last 20 minutes we have not shown.
  useEffect(() => {
    let off = false;
    api
      .get('/api/alerts/recent', RecentBannersResponseSchema)
      .then(({ banners }) => {
        if (off || banners.length === 0) return;
        const seen = readNum(SEEN_KEY);
        const max = Math.max(...banners.map((b) => b.id));
        writeNum(SEEN_KEY, Math.max(max, seen ?? 0));
        if (seen === null) return; // first visit: do not replay history
        const missed = banners.filter((b) => b.id > seen && serverNow() - b.at < 20 * 60_000).slice(-2);
        missed.forEach((b, i) => window.setTimeout(() => show(b), 600 + i * 900));
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);
  return (
    <div className={s.bannerLane}>
      <AnimatePresence>{current && <TapeBanner key={current.id} b={current} onGone={clear} />}</AnimatePresence>
    </div>
  );
}

type TestState = 'idle' | 'sending' | 'waiting' | 'arrived' | 'missed';

/** After a test push, watch for the notification to show up (the service worker puts it in getNotifications). */
function useArrival() {
  const [state, setState] = useState<TestState>('idle');
  const timer = useRef(0);
  const watch = useCallback(() => {
    setState('waiting');
    const t0 = Date.now();
    window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      let found = false;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const list = (await reg?.getNotifications({ tag: 'ah-test' })) ?? [];
        found = list.length > 0;
        list.forEach((n) => n.close());
      } catch {
        /* no registration: treat as missed below */
      }
      if (found) {
        window.clearInterval(timer.current);
        setState('arrived');
        celebrate({ y: 0.55 });
      } else if (Date.now() - t0 > 12_000) {
        window.clearInterval(timer.current);
        setState('missed');
      }
    }, 450);
  }, []);
  useEffect(() => () => window.clearInterval(timer.current), []);
  return { state, setState, watch };
}

export function PushCard() {
  const toast = useToast();
  const [state, setState] = useState<'ask' | 'on' | 'hidden'>(() => {
    const dismissed = readNum(PUSH_DISMISS) === 1;
    if (dismissed) return 'hidden';
    const p = pushPermission();
    if (p === 'denied') return 'hidden';
    if (p === 'unsupported' && !isIOS()) return 'hidden';
    return 'ask';
  });
  const [help, setHelp] = useState(false);
  const [justOn, setJustOn] = useState(false);
  useEffect(() => {
    void isSubscribed().then((on) => on && setState('on'));
  }, []);
  const reduce = useReducedMotion();
  const arrival = useArrival();
  const test = useMutation({
    mutationFn: () => api.post('/api/alerts/test', {}, TestPushResponseSchema),
    onMutate: () => arrival.setState('sending'),
    onSuccess: (r) => {
      if (r.sent > 0) arrival.watch();
      else {
        arrival.setState('idle');
        toast(r.pushEnabled ? 'no device registered yet. try turning alerts on again.' : 'push is off on the server today. in-app banners still work.', { kind: 'info', title: 'hmm' });
      }
    },
    onError: (e) => {
      arrival.setState('idle');
      toast(e.message, { kind: 'bad' });
    },
  });
  const turnOn = useMutation({
    mutationFn: enablePush,
    onSuccess: (r) => {
      if (r === 'on') {
        setState('on');
        setJustOn(true);
        celebrate({ y: 0.6 });
      } else if (r === 'denied') toast('no worries. banners still pop up while the app is open.', { kind: 'info', title: 'alerts blocked' });
      else if (r === 'server-off') toast('push is not set up today. in-app banners still work.', { kind: 'info' });
      else toast('this browser cannot do push. banners still work in the app.', { kind: 'info' });
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  if (state === 'hidden' || (state === 'on' && !justOn)) return null;
  const iosNeedsInstall = isIOS() && !isStandalone();
  const dismiss = () => {
    writeNum(PUSH_DISMISS, 1);
    setState('hidden');
  };
  return (
    <Card tone="grape" tilt={1} tape="left" tapeColor="pink" className={s.pushCard}>
      <div className={s.pushRow}>
        <motion.span
          className={`${s.bell} ${arrival.state === 'waiting' || state === 'ask' ? s.ringing : ''}`}
          animate={arrival.state === 'arrived' && !reduce ? { scale: [1, 1.5, 1], rotate: [-10, 25, -10] } : undefined}
          transition={{ duration: 0.6 }}
        >
          <Doodle name="bell" size={40} fill="var(--sun)" strokeWidth={2.4} />
        </motion.span>
        <div className={ui.stack}>
          <h3 className={s.pushTitle}>{arrival.state === 'arrived' ? 'it landed!' : state === 'on' ? 'alerts are on' : 'ping me before the big stuff'}</h3>
          <p className={s.pushText}>
            {arrival.state === 'waiting'
              ? 'sent. watch your notification shade...'
              : arrival.state === 'arrived'
                ? 'that buzz is what you get 15 min before a highlight.'
                : arrival.state === 'missed'
                  ? 'did not see it arrive. check your notification settings, then try again.'
                  : state === 'on'
              ? 'we will buzz you 15 min before the highlights. want a test?'
              : iosNeedsInstall
                ? 'on iphone, alerts only work once the app is on your home screen.'
                : 'three highlights today. we will buzz you 15 min before each. no spam.'}
          </p>
        </div>
      </div>
      <div className={ui.row}>
        {state === 'on' ? (
          <Button tone="lime" size="sm" icon="bell" onClick={() => test.mutate()} loading={test.isPending || arrival.state === 'waiting'}>
            {arrival.state === 'arrived' || arrival.state === 'missed' ? 'again' : 'send a test'}
          </Button>
        ) : iosNeedsInstall ? (
          <Button tone="lime" size="sm" icon="phone" onClick={() => setHelp(true)}>
            show me how
          </Button>
        ) : (
          <Button tone="lime" size="sm" icon="bell" onClick={() => turnOn.mutate()} loading={turnOn.isPending} disabled={!pushSupported()}>
            turn on alerts
          </Button>
        )}
        <Button tone="paper" size="sm" ghost onClick={dismiss} className={s.ghostOnDark}>
          {state === 'on' ? 'done' : 'not now'}
        </Button>
      </div>
      <InstallHelp open={help} onClose={() => setHelp(false)} />
    </Card>
  );
}

/*
  Sign out, on the phone. Easy to find (bottom of home and of the sticker book), hard to hit by accident:
  the button opens an in-page confirm card (never window.confirm) that says what happens next.

  Binding rules (server/src/core/auth/routes.ts): signing out deletes this session and its cookie only.
  The kit (printed card or student-ID roster kit) stays bound to this phone's browser through the
  long-lived device cookie, so the same card or student ID signs straight back in here. On another phone,
  or after clearing this browser's data, the desk resets the binding first.
*/
import type { MeResponse } from '@afterhours/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSignOut } from '../../core/queries';
import { Button, Card, useToast } from '../../kit';
import s from './attendee.module.css';

export function SignOutButton({ me }: { me: MeResponse }) {
  const [asking, setAsking] = useState(false);
  const signOut = useSignOut();
  const navigate = useNavigate();
  const toast = useToast();
  const reduce = useReducedMotion();
  const who = me.attendee.nickname ?? me.attendee.name ?? 'you';
  return (
    <div className={s.signoutBox}>
      <AnimatePresence initial={false} mode="wait">
        {asking ? (
          <motion.div key="ask" initial={reduce ? { opacity: 0 } : { y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}>
            <Card tone="paper" tilt={-0.6} className={s.signoutCard} role="alertdialog" aria-labelledby="signout-title" data-testid="signout-confirm">
              <h3 id="signout-title" className={s.signoutTitle}>
                sign out of after hours?
              </h3>
              <p className={s.signoutText}>
                your points and stickers stay put. your kit card or student ID stays tied to <b>this phone</b>, so you can sign back in right here, in this browser, with the same card or ID.
              </p>
              <p className={s.signoutText}>on another phone, or after clearing this browser, ask the desk to reset it first.</p>
              <div className={s.signoutBtns}>
                <Button
                  tone="pink"
                  icon="lock"
                  loading={signOut.isPending}
                  onClick={() =>
                    signOut.mutate(undefined, {
                      onSuccess: () => navigate('/', { replace: true }),
                      onError: (e) => toast(e.message, { kind: 'bad' }),
                    })
                  }
                >
                  yes, sign out
                </Button>
                <Button tone="lime" onClick={() => setAsking(false)}>
                  stay signed in
                </Button>
              </div>
            </Card>
          </motion.div>
        ) : (
          <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Button tone="paper" size="sm" ghost icon="lock" onClick={() => setAsking(true)} data-testid="signout-open">
              sign out ({who})
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

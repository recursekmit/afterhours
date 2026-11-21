/*
  First sign-in: confirm who you are, build a face. No usernames: everyone is shown by their own name (for
  people on the participant list, the registered name and roll, fixed).
  Saving it is the second celebration (the first is signing in).
*/
import { type AvatarConfig, DEFAULT_AVATAR, type MeResponse, ProfileInputSchema, avatarFromSeed } from '@afterhours/shared';
import { useState } from 'react';
import { isApiError } from '../../core/api';
import { useSaveProfile } from '../../core/queries';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Scribble, TextField } from '../../kit';
import { AvatarBuilder } from './AvatarBuilder';
import s from './attendee.module.css';

export function Profile({ me }: { me: MeResponse }) {
  const save = useSaveProfile();
  // on the participant list: the registered name and roll are what everyone sees, and they are fixed
  const fromList = Boolean(me.preset.name);
  const [name, setName] = useState(me.preset.name ?? me.attendee.name ?? '');
  const [roll, setRoll] = useState(me.preset.roll ?? me.attendee.roll ?? '');
  const [avatar, setAvatar] = useState<AvatarConfig>(() => ({ ...DEFAULT_AVATAR, ...avatarFromSeed(me.attendee.id * 31 + 7) }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ProfileInputSchema.safeParse({ name, roll, avatar });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      setErrors(next);
      sfx.fail();
      haptics.fail();
      return;
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: () => celebrate({ y: 0.55 }),
      onError: (err) => {
        const next: Record<string, string> = {};
        if (isApiError(err) && err.issues?.length) for (const i of err.issues) next[i.path.split('.')[0] ?? 'form'] ??= i.message;
        else next.form = err.message;
        setErrors(next);
        sfx.fail();
      },
    });
  };

  return (
    <form className={s.profile} onSubmit={submit} noValidate>
      <header className={s.profileHead}>
        <h1 className={s.bigTitle}>who are you?</h1>
        <Scribble color="var(--pink)" style={{ width: 170 }} />
        <p className={s.handNote}>build a face. poke it. it pokes back.</p>
      </header>

      <AvatarBuilder value={avatar} onChange={setAvatar} />

      <Card tone="paper" tilt={0.6} tape tapeColor="sky" className={s.fieldsCard}>
        <TextField label="your name (shows on the leaderboard)" value={name} onChange={(e) => setName(e.target.value)} readOnly={fromList} autoComplete="name" error={errors.name} data-testid="profile-name" />
        <TextField label="roll number" value={roll} onChange={(e) => setRoll(e.target.value)} readOnly={fromList} autoCapitalize="characters" autoComplete="off" error={errors.roll} style={{ textTransform: 'uppercase' }} />
        {fromList && <p className={s.handNote}>this is the name you registered with. wrong? tell the desk.</p>}
      </Card>

      {errors.form && (
        <p className={s.formError} role="alert">
          {errors.form}
        </p>
      )}
      <Button type="submit" tone="lime" size="lg" block loading={save.isPending} icon="check">
        that&apos;s me
      </Button>
    </form>
  );
}

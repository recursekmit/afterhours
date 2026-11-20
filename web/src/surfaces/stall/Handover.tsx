/*
  The redemption sheet. Who it is, how many free mocktails they have left (big), their points, their basket
  pre-filled, and this stall's menu as big tiles. A clear green/red line says whether it can go through,
  and one big "hand it over" button commits. The server checks everything again inside one transaction;
  the same basket always sends the same key, so a double tap or a retry on bad Wi-Fi commits once.
*/
import { type CartLine, type CommitResponse, type ItemView, type ScanResponse, planCart } from '@afterhours/shared/features/stalls';
import { useMemo, useRef, useState } from 'react';
import { ApiError, isApiError } from '../../core/api';
import { haptics, sfx } from '../../fun';
import { Avatar, Button, Doodle } from '../../kit';
import { changeLine } from '../../features/stalls/api';
import { Glasses } from '../../features/stalls/Wallet';
import { Thumb, linesText, pts } from '../../features/stalls/parts';
import { commitKey, newSheetId, shopCommit } from './api';
import s from './stall.module.css';

function Tile({ item, qty, freeLeft, blocked, onChange }: { item: ItemView; qty: number; freeLeft: number; blocked: string | null; onChange: (d: number) => void }) {
  const free = item.freeDrink && freeLeft > 0;
  const off = blocked !== null && qty === 0;
  return (
    <li className={`${s.tile} ${qty > 0 ? s.tileOn : ''} ${off ? s.tileOff : ''}`}>
      <button type="button" className={s.tileMain} disabled={off} onClick={() => onChange(1)} aria-label={`add ${item.name}`}>
        <Thumb src={item.image} name={item.name} size={64} />
        <span className={s.tileName}>{item.name}</span>
        <span className={s.tilePrice}>{free ? 'free drink' : item.price === 0 ? 'free' : pts(item.price)}</span>
        {blocked && <span className={s.tileBlock}>{blocked}</span>}
      </button>
      {qty > 0 && (
        <div className={s.tileQty}>
          <button type="button" className={s.qtyBtn} aria-label={`one less ${item.name}`} onClick={() => onChange(-1)}>
            <Doodle name="close" size={22} stroke="currentColor" />
          </button>
          <b className={s.qtyNum} aria-live="polite">
            {qty}
          </b>
        </div>
      )}
    </li>
  );
}

export function Handover({ scan, onCancel, onDone, onExpired }: { scan: ScanResponse; onCancel: () => void; onDone: (r: CommitResponse) => void; onExpired: (msg: string) => void }) {
  const [lines, setLines] = useState<CartLine[]>(scan.cart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetId = useRef(newSheetId());

  const plan = useMemo(
    () =>
      planCart({
        items: scan.menu.map((m) => ({ id: m.id, name: m.name, price: m.price, freeDrink: m.freeDrink, stockLeft: m.stockLeft, limitLeft: m.limit === null ? null : Math.max(0, m.limit - m.bought) })),
        lines,
        freeLeft: scan.allowance.left,
        balance: scan.balance,
      }),
    [scan, lines],
  );
  const mocktailPrice = scan.menu.filter((m) => m.freeDrink && m.price > 0).reduce<number | null>((lo, m) => (lo === null || m.price < lo ? m.price : lo), null);
  const empty = lines.length === 0;
  const ok = plan.ok && !empty;

  const blockedFor = (m: ItemView): string | null => {
    if (m.stockLeft !== null && m.stockLeft <= 0) return 'sold out';
    if (m.limit !== null && m.bought >= m.limit) return `limit ${m.limit} reached`;
    const free = m.freeDrink && scan.allowance.left > 0;
    if (!free && m.price > scan.balance) return `${m.price - scan.balance} pts short`;
    if (m.freeDrink && scan.allowance.left <= 0 && m.price === 0) return 'no free drinks left';
    return null;
  };

  const change = (id: number, d: number) => {
    setError(null);
    sfx.tick();
    haptics.tick();
    setLines((cur) => changeLine(cur, id, d));
  };

  const hand = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await shopCommit(scan.ticket, commitKey(sheetId.current, lines), lines);
      onDone(r);
    } catch (e) {
      sfx.fail();
      haptics.fail();
      if (isApiError(e, 'bad_token') || isApiError(e, 'ticket_used')) onExpired(e.message);
      else if (e instanceof ApiError && e.status === 0) setError("no connection. tap hand it over again: it won't charge twice.");
      else setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const status = empty ? 'tap items to add them' : ok ? 'ok' : (plan.problems[0] ?? "can't do that");
  const detail = empty
    ? 'nothing in the basket yet.'
    : plan.ok
      ? `${plan.freeUsed > 0 ? `${plan.freeUsed} free drink${plan.freeUsed > 1 ? 's' : ''}` : ''}${plan.freeUsed > 0 && plan.points > 0 ? ' + ' : ''}${plan.points > 0 ? pts(plan.points) : plan.freeUsed > 0 ? '' : 'no points'}`
      : '';

  return (
    <main className={s.sheet}>
      <section className={s.who}>
        <Avatar config={scan.attendee.avatar} size={84} />
        <div className={s.whoText}>
          <h1 className={s.whoNick}>{scan.attendee.nickname}</h1>
          <p className={s.whoPts}>
            <b>{scan.balance}</b> points to spend
          </p>
        </div>
        <div className={s.free} aria-label={`${scan.allowance.left} free mocktails left`}>
          <span className={s.freeNum}>{scan.allowance.left}</span>
          <span className={s.freeLabel}>free mocktail{scan.allowance.left === 1 ? '' : 's'} left</span>
          <Glasses total={scan.allowance.total} left={scan.allowance.left} size={30} />
        </div>
      </section>

      <section className={s.routes} aria-label="three ways to a mocktail">
        <div className={`${s.route} ${scan.allowance.left > 0 ? s.routeOn : ''}`}>
          <span className={s.routeNum}>{scan.allowance.left}</span>
          <span className={s.routeLabel}>free left</span>
        </div>
        <div className={`${s.route} ${scan.allowance.left <= 0 && mocktailPrice !== null && scan.balance >= mocktailPrice ? s.routeOn : ''}`}>
          <span className={s.routeNum}>{scan.balance}</span>
          <span className={s.routeLabel}>{mocktailPrice !== null ? `pts, mocktail ${mocktailPrice}` : 'pts'}</span>
        </div>
        <div className={s.route}>
          <span className={s.routeNum}>{scan.puzzle ? scan.puzzle.tokens : 0}</span>
          <span className={s.routeLabel}>{scan.puzzle ? `puzzle tokens, ${scan.puzzle.cost} each` : 'puzzle tokens'}</span>
        </div>
      </section>

      {scan.menu.length === 0 ? (
        <p className={s.note}>this stall has no items yet. ask the organisers to add some.</p>
      ) : (
        <ul className={s.tiles}>
          {scan.menu.map((m) => (
            <Tile key={m.id} item={m} qty={lines.find((l) => l.itemId === m.id)?.qty ?? 0} freeLeft={scan.allowance.left} blocked={blockedFor(m)} onChange={(d) => change(m.id, d)} />
          ))}
        </ul>
      )}

      <footer className={`${s.dock} ${empty ? s.dockIdle : ok ? s.dockOk : s.dockBad}`}>
        <div className={s.verdict} role="status" aria-live="polite">
          <span className={s.verdictMark} aria-hidden="true">
            {empty ? <Doodle name="plus" size={30} stroke="currentColor" /> : ok ? <Doodle name="check" size={34} stroke="currentColor" /> : <Doodle name="close" size={30} stroke="currentColor" />}
          </span>
          <span>
            <b className={s.verdictMain}>{status}</b>
            {(detail || error) && <span className={s.verdictSub}>{error ?? `${linesText(plan.lines)}: ${detail}`}</span>}
          </span>
        </div>
        <div className={s.dockBtns}>
          <Button tone="paper" size="lg" className={s.cancel} onClick={onCancel} disabled={busy}>
            cancel
          </Button>
          <Button tone={ok ? 'lime' : 'paper'} size="lg" className={s.hand} disabled={!ok} loading={busy} onClick={() => void hand()}>
            hand it over
          </Button>
        </div>
      </footer>
    </main>
  );
}

/*
  /wallet on the phone: a cut-paper ticket with your points to spend and your free mocktails (two big
  glasses that get used up), a "show my QR" button, the stall menus with "you can afford this"
  highlighting, an optional basket the shopkeeper sees pre-filled, and a receipt list.
*/
import { type ItemView, type NextMocktail as NextMocktailT, type PlanItem, type Receipt, type StallMenu, mocktailProgress, planCart } from '@afterhours/shared/features/stalls';
import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button, Card, Doodle, ErrorState, LinkButton, LoadingState, Meter, NumberTicker, Torn } from '../../kit';
import { PageHead, Stamp, ui } from '../common/ui';
import { changeLine, useCart, useMenu, useSetCart, useWallet } from './api';
import { Mocktail, StallMark, Thumb, clockTime, linesText, pts } from './parts';
import s from './stalls.module.css';

export function Glasses({ total, left, size = 64, wobble }: { total: number; left: number; size?: number; wobble?: boolean }) {
  const tones = ['pink', 'lime', 'sky', 'tangerine'] as const;
  return (
    <div className={s.glasses} role="img" aria-label={`${left} of ${total} free mocktails left`}>
      {Array.from({ length: total }, (_, i) => (
        <Mocktail key={i} full={i < left} size={size} tone={tones[i % tones.length] ?? 'pink'} wobble={wobble && i < left} />
      ))}
    </div>
  );
}

function Ticket() {
  const w = useWallet();
  const reduce = useReducedMotion();
  if (w.isPending) return <LoadingState label="counting your points..." />;
  if (w.isError) return <ErrorState error={w.error} onRetry={() => void w.refetch()} />;
  const d = w.data;
  const left = d.allowance.left;
  return (
    <motion.div initial={reduce ? false : { rotate: -3, y: 14, opacity: 0 }} animate={{ rotate: -1, y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
      <Card tone="sun" tape tapeColor="pink" className={s.ticket}>
        <div className={s.ticketTop}>
          <div>
            <p className={s.hand}>points to spend</p>
            <p className={s.bigNum}>
              <NumberTicker value={d.balance} />
            </p>
            <p className={s.fine}>
              earned {d.earned}, spent {d.spent}
            </p>
          </div>
          <Doodle name="ticket" size={54} fill="var(--paper-3)" />
        </div>
        <div className={s.perf} aria-hidden="true" />
        <div className={s.ticketMid}>
          <Glasses total={d.allowance.total} left={left} wobble />
          <div>
            <p className={s.drinkLine}>{left > 0 ? `${left} free mocktail${left === 1 ? '' : 's'} left` : d.allowance.total > 0 ? 'free mocktails all used' : 'no free ones today'}</p>
            <p className={s.fine}>{left > 0 ? 'everyone gets ' + d.allowance.total + '. after that, earn more by playing.' : 'earn more by playing, then buy one with points.'}</p>
          </div>
        </div>
        {d.nextMocktail && <NextMocktail balance={d.balance} next={d.nextMocktail} />}
        {d.puzzle && (d.puzzle.tokens > 0 || d.puzzle.cost > 0) && (
          <p className={s.puzzle}>
            puzzle tokens: <b>{d.puzzle.tokens}</b> <span className={s.fine}>({d.puzzle.cost} = one mocktail, claimed at the arcade desk)</span>
          </p>
        )}
        <LinkButton to="/wallet/qr" tone="lime" size="lg" block icon="qr">
          show my QR
        </LinkButton>
      </Card>
    </motion.div>
  );
}

/** The bar to the next mocktail bought with points. */
function NextMocktail({ balance, next }: { balance: number; next: NextMocktailT }) {
  const p = mocktailProgress(balance, next.price);
  return (
    <div className={s.next}>
      <Meter value={p.fraction} tone="lime" label="progress to your next mocktail" />
      <p className={s.fine}>
        {p.affordable > 0
          ? `your points already buy ${p.affordable} ${next.name.toLowerCase()}${p.affordable === 1 ? '' : 's'} (${next.price} pts at ${next.stallName}). ${p.toNext} more to the next.`
          : `${p.toNext} more points to your next mocktail (${next.price} pts at ${next.stallName}).`}
      </p>
    </div>
  );
}

/** What the home screen shows: the same facts, smaller. */
export function WalletHomeCard() {
  const w = useWallet();
  const d = w.data;
  const total = d?.allowance.total ?? 2;
  return (
    <Card tone="paper" tilt={-0.8} tape tapeColor="sky">
      <div className={s.homeCard}>
        <div className={s.homeTop}>
          <div>
            <h3 className={s.homeTitle}>mocktails + stalls</h3>
            <p className={s.fine}>
              {total > 0 ? `${total} free mocktail${total === 1 ? '' : 's'}, then earn more by playing.` : 'earn mocktails by playing.'} spending never drops your rank.
            </p>
          </div>
          <Link to="/wallet" className={s.homeBal} aria-label={`open wallet, ${d?.balance ?? 0} points to spend`}>
            <NumberTicker value={d?.balance ?? 0} />
            <span className={s.hand}>pts</span>
          </Link>
        </div>
        <div className={s.homeRow}>
          {d && <Glasses total={d.allowance.total} left={d.allowance.left} size={40} />}
          <span className={s.drinkLine}>{d ? (d.allowance.left > 0 ? `${d.allowance.left} free left` : 'free ones used') : '...'}</span>
        </div>
        {d?.nextMocktail && <NextMocktail balance={d.balance} next={d.nextMocktail} />}
        <div className={s.homeBtns}>
          <LinkButton to="/wallet/qr" tone="lime" size="sm" icon="qr">
            show my QR
          </LinkButton>
          <LinkButton to="/wallet" tone="paper" size="sm">
            menus and receipts
          </LinkButton>
        </div>
      </div>
    </Card>
  );
}

function toPlanItem(i: ItemView): PlanItem {
  return { id: i.id, name: i.name, price: i.price, freeDrink: i.freeDrink, stockLeft: i.stockLeft, limitLeft: i.limit === null ? null : Math.max(0, i.limit - i.bought) };
}

function ItemRow({ item, qty, balance, freeLeft, onChange }: { item: ItemView; qty: number; balance: number; freeLeft: number; onChange: (delta: number) => void }) {
  const soldOut = item.stockLeft !== null && item.stockLeft <= 0;
  const limitLeft = item.limit === null ? null : Math.max(0, item.limit - item.bought);
  const capped = limitLeft !== null && limitLeft <= 0;
  const free = item.freeDrink && freeLeft > 0;
  const can = !soldOut && !capped && (free || item.price <= balance);
  const max = Math.min(item.stockLeft ?? 20, limitLeft ?? 20, 20);
  const short = item.price - balance;
  return (
    <li className={`${s.item} ${can ? s.itemCan : ''} ${soldOut || capped ? s.itemOut : ''}`}>
      <Thumb src={item.image} name={item.name} />
      <div className={s.itemBody}>
        <p className={s.itemName}>{item.name}</p>
        <p className={s.itemMeta}>
          {item.freeDrink && freeLeft > 0 ? <b className={s.freeTag}>free with your allowance</b> : <b className={`${s.price} ${can ? s.priceOk : ''}`}>{item.price === 0 ? 'free' : pts(item.price)}</b>}
          {soldOut ? ' sold out' : capped ? ` limit reached (${item.limit})` : !can && short > 0 ? ` need ${short} more` : ''}
          {!soldOut && item.stockLeft !== null && item.stockLeft <= 10 ? `, ${item.stockLeft} left` : ''}
          {!soldOut && !capped && item.limit !== null ? `, max ${item.limit} each` : ''}
        </p>
      </div>
      <div className={s.stepper}>
        <button type="button" className={s.stepBtn} aria-label={`one less ${item.name}`} disabled={qty === 0} onClick={() => onChange(-1)}>
          <Doodle name="close" size={16} stroke="currentColor" />
        </button>
        <span className={s.stepQty} aria-live="polite">
          {qty}
        </span>
        <button type="button" className={s.stepBtn} aria-label={`add ${item.name}`} disabled={soldOut || capped || qty >= max} onClick={() => onChange(1)}>
          <Doodle name="plus" size={16} stroke="currentColor" />
        </button>
      </div>
    </li>
  );
}

function ReceiptRow({ r }: { r: Receipt }) {
  const void_ = r.status === 'void';
  return (
    <li className={`${s.receipt} ${void_ ? s.receiptVoid : ''}`}>
      <div>
        <p className={s.receiptWhat}>{linesText(r.lines)}</p>
        <p className={s.fine}>
          {r.stallName}, {clockTime(r.at)}
        </p>
      </div>
      <div className={s.receiptCost}>
        {void_ ? <Stamp tone="late">voided</Stamp> : <b>{r.totalPoints > 0 ? `-${r.totalPoints}` : 'free'}</b>}
        {!void_ && r.freeUsed > 0 && <span className={s.fine}>{r.freeUsed} free drink</span>}
      </div>
    </li>
  );
}

export function WalletPage() {
  const wallet = useWallet();
  const menu = useMenu();
  const cart = useCart();
  const setCart = useSetCart();
  const [pick, setPick] = useState<number | null>(null);
  const lines = useMemo(() => cart.data?.lines ?? [], [cart.data]);
  const stalls: StallMenu[] = useMemo(() => menu.data?.stalls ?? [], [menu.data]);
  const active = stalls.find((st) => st.id === pick) ?? stalls[0];
  const balance = wallet.data?.balance ?? 0;
  const freeLeft = wallet.data?.allowance.left ?? 0;

  const plan = useMemo(() => {
    const items = stalls.flatMap((st) => st.items.map(toPlanItem));
    return planCart({ items, lines, freeLeft, balance });
  }, [stalls, lines, freeLeft, balance]);
  const count = lines.reduce((a, l) => a + l.qty, 0);

  return (
    <div className={ui.page}>
      <PageHead title="wallet" note="your points, your free drinks, and what's on at the stalls." color="var(--lime)" />
      <Ticket />
      <p className={`${s.hand} ${s.rankNote}`}>spending doesn't touch your rank. the board counts what you earn, not what you spend.</p>

      <section className={s.section} aria-labelledby="menu-h">
        <h2 id="menu-h" className={ui.cardTitle}>
          the stalls
        </h2>
        {menu.isPending ? (
          <LoadingState label="reading the menus..." />
        ) : menu.isError ? (
          <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
        ) : stalls.length === 0 ? (
          <Card tone="paper" flat>
            <p className={s.hand}>the menus aren't up yet. the organisers are still setting up the stalls. check back soon.</p>
          </Card>
        ) : (
          <>
            <div className={s.chips} role="tablist" aria-label="stalls">
              {stalls.map((st) => (
                <button key={st.id} type="button" role="tab" aria-selected={st.id === active?.id} className={`${s.chip} ${st.id === active?.id ? s.chipOn : ''}`} onClick={() => setPick(st.id)}>
                  <StallMark value={st.emoji} size={20} />
                  {st.name}
                </button>
              ))}
            </div>
            {active && (
              <>
                {active.location && (
                  <p className={s.hand}>
                    find it: {active.location}
                  </p>
                )}
                <ul className={s.items}>
                  {active.items.map((it) => (
                    <ItemRow key={it.id} item={it} qty={lines.find((l) => l.itemId === it.id)?.qty ?? 0} balance={balance} freeLeft={freeLeft} onChange={(d) => setCart.mutate(changeLine(lines, it.id, d))} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {count > 0 && (
        <Torn tone={plan.ok ? 'lime' : 'pink'} className={s.basket}>
          <div className={s.basketRow}>
            <div>
              <p className={s.basketTitle}>
                your basket: {count} thing{count === 1 ? '' : 's'}
              </p>
              <p className={s.fine}>
                {plan.ok ? `${plan.points > 0 ? pts(plan.points) : 'no points'}${plan.freeUsed ? `, ${plan.freeUsed} free drink` : ''}. the shopkeeper sees it when they scan you.` : (plan.problems[0] ?? '')}
              </p>
            </div>
            <Button size="sm" tone="paper" onClick={() => setCart.mutate([])}>
              clear
            </Button>
          </div>
          <LinkButton to="/wallet/qr" tone="ink" block icon="qr" size="sm">
            show my QR
          </LinkButton>
        </Torn>
      )}

      <section className={s.section} aria-labelledby="rc-h">
        <h2 id="rc-h" className={ui.cardTitle}>
          what you got
        </h2>
        {wallet.data && wallet.data.receipts.length === 0 && <p className={s.hand}>nothing yet. your first mocktail is waiting.</p>}
        <ul className={s.receipts}>{wallet.data?.receipts.map((r) => <ReceiptRow key={r.id} r={r} />)}</ul>
      </section>
    </div>
  );
}

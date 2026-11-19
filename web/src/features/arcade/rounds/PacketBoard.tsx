/*
  Packet Panic board. An SVG network (100 x 64 units, scales to the phone).
  - Pick a packet (letter + shape + colour), tap a blue junction to turn that packet's arrow.
  - Send: the server simulates the plan; we replay its tick-by-tick frames, so each packet visibly
    follows the arrows you set, queues at full wires and stops dead where it got stuck.
  - Afterwards every packet gets a line saying where it ended up and why; the wire or junction
    that stopped it is ringed on the map.
*/
import { choiceNodes, type NetLink, type NetNode, type PacketOutcome, type PacketPos, type RoutePlan, outLinks } from '@afterhours/shared/features/arcade-net';
import type { TryResponse } from '@afterhours/shared/features/arcade-rounds';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { haptics, sfx } from '../../../fun';
import { Button } from '../../../kit';
import type { BoardProps } from './Play';
import s from './rounds.module.css';

const PACKET_STYLE = [
  { fill: 'var(--tangerine)', shape: 'circle' },
  { fill: 'var(--sky)', shape: 'square' },
  { fill: 'var(--pink)', shape: 'diamond' },
  { fill: 'var(--lime)', shape: 'triangle' },
  { fill: 'var(--sun)', shape: 'circle' },
  { fill: 'var(--grape)', shape: 'square' },
] as const;
const FRAME_MS = 520;

type Playback = { result: Extract<TryResponse['outcome'], { game: 'packet' }>['result']; frame: number; done: boolean; response: TryResponse };

function PacketShape({ i, r = 2.6 }: { i: number; r?: number }) {
  const st = PACKET_STYLE[i % PACKET_STYLE.length]!;
  if (st.shape === 'circle') return <circle r={r} fill={st.fill} className={s.packet} />;
  if (st.shape === 'square') return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={0.6} fill={st.fill} className={s.packet} />;
  if (st.shape === 'diamond') return <rect x={-r * 0.85} y={-r * 0.85} width={r * 1.7} height={r * 1.7} transform="rotate(45)" fill={st.fill} className={s.packet} />;
  return <polygon points={`0,${-r * 1.15} ${r * 1.1},${r * 0.85} ${-r * 1.1},${r * 0.85}`} fill={st.fill} className={s.packet} />;
}

function PacketChip({ i, label }: { i: number; label: string }) {
  return (
    <svg viewBox="-4 -4 8 8" width="28" height="28" aria-hidden="true">
      <PacketShape i={i} r={3} />
      <text className={s.packetLabel} style={{ fontSize: 3.4 }}>
        {label}
      </text>
    </svg>
  );
}

const unit = (a: NetNode, b: NetNode) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { ux: dx / d, uy: dy / d, d };
};

export function PacketBoard({ body, attempt, onTry, busy, resetKey, onWin }: BoardProps<'packet'>) {
  const net = body.network;
  const reduce = useReducedMotion();
  const nodes = useMemo(() => new Map(net.nodes.map((n) => [n.id, n])), [net]);
  const outs = useMemo(() => outLinks(net), [net]);
  const choices = useMemo(() => new Set(choiceNodes(net)), [net]);
  const [plan, setPlan] = useState<RoutePlan>({});
  const [sel, setSel] = useState(net.packets[0]!.id);
  const [play, setPlay] = useState<Playback | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setPlan({});
    setPlay(null);
  }, [resetKey]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const hint = attempt.hint?.game === 'packet' ? attempt.hint : null;
  const wireName = (l: NetLink) => `${nodes.get(l.from)?.label} to ${nodes.get(l.to)?.label}`;
  const nodeLabel = (id: string) => nodes.get(id)?.label ?? id;
  const won = attempt.status === 'won';

  const turn = (nodeId: string) => {
    if (busy || (play && !play.done) || won) return;
    const ways = outs.get(nodeId) ?? [];
    const cur = plan[sel]?.[nodeId];
    const i = ways.findIndex((w) => w.id === cur);
    const next = ways[(i + 1) % ways.length]!;
    setPlan((p) => ({ ...p, [sel]: { ...(p[sel] ?? {}), [nodeId]: next.id } }));
    setPlay(null);
    sfx.tick();
    haptics.tick();
  };

  const send = async () => {
    window.clearInterval(timer.current);
    setPlay(null);
    const r = await onTry({ game: 'packet', routes: plan }).catch(() => null);
    if (!r || r.outcome.game !== 'packet') return;
    const result = r.outcome.result;
    sfx.whoosh();
    let f = 0;
    setPlay({ result, frame: 0, done: false, response: r });
    timer.current = window.setInterval(
      () => {
        f++;
        if (f >= result.frames.length) {
          window.clearInterval(timer.current);
          setPlay((p) => (p ? { ...p, frame: result.frames.length - 1, done: true } : p));
          if (r.ok) onWin(r);
          else {
            sfx.fail();
            haptics.fail();
          }
          return;
        }
        sfx.tick();
        setPlay((p) => (p ? { ...p, frame: f } : p));
      },
      reduce ? FRAME_MS / 2 : FRAME_MS,
    );
  };

  // Where each packet sits right now.
  const posOf = (pos: PacketPos | undefined, i: number, id: string) => {
    const spread = (k: number) => ({ dx: ((k % 2) * 2 - 1) * 2.4 * (k > 1 ? 1 : 0.6), dy: (k > 1 ? 1 : -1) * 2.4 });
    const p = net.packets.find((x) => x.id === id)!;
    if (!pos || pos.at === 'node') {
      const n = nodes.get(pos?.node ?? p.from)!;
      const o = spread(i);
      return { x: n.x + o.dx, y: n.y + o.dy };
    }
    const l = net.links.find((x) => x.id === pos.link)!;
    const a = nodes.get(l.from)!;
    const b = nodes.get(l.to)!;
    const f = pos.step / (pos.of + 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
  const frame = play ? play.result.frames[play.frame] : undefined;
  const outcomes: PacketOutcome[] | null = play?.done ? play.result.outcomes : null;
  const badLinks = new Set(outcomes?.filter((o) => o.status !== 'delivered' && o.link).map((o) => o.link!));
  const badNodes = outcomes?.filter((o) => o.status !== 'delivered') ?? [];
  const selIdx = net.packets.findIndex((p) => p.id === sel);

  return (
    <div className={s.board}>
      <div>
        <div className={s.tickBar}>
          <span>tick {play ? play.frame : 0}</span>
          <span className={s.say}>deadline: tick {net.deadline}</span>
        </div>
        <svg className={s.net} viewBox="-2 0 104 66" role="img" aria-label={`network with ${net.nodes.length} stops and ${net.packets.length} packets`}>
          {/* wires */}
          {net.links.map((l) => {
            const a = nodes.get(l.from)!;
            const b = nodes.get(l.to)!;
            const { ux, uy } = unit(a, b);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const lit = !play && plan[sel]?.[l.from] === l.id;
            const tags = [l.length && l.length > 1 ? `${l.length}t` : null, l.capacity && l.capacity > 1 ? `x${l.capacity}` : null].filter(Boolean).join(' ');
            return (
              <g key={l.id}>
                <line
                  x1={a.x + ux * 4}
                  y1={a.y + uy * 4}
                  x2={b.x - ux * 5}
                  y2={b.y - uy * 5}
                  className={`${s.wire} ${(l.capacity ?? 1) > 1 ? s.wireFat : ''} ${l.downAt !== undefined ? s.wireDown : ''} ${lit ? s.wireLit : ''}`}
                  style={badLinks.has(l.id) ? { stroke: 'var(--pink)', strokeWidth: 1.8 } : undefined}
                />
                {tags && (
                  <g transform={`translate(${mx} ${my})`}>
                    <rect x={-tags.length * 1.15 - 1} y={-2.3} width={tags.length * 2.3 + 2} height={4.6} rx={1} className={s.wireTagBg} />
                    <text className={s.wireTag} textAnchor="middle" dominantBaseline="central">
                      {tags}
                    </text>
                  </g>
                )}
                {l.downAt !== undefined && (
                  <g transform={`translate(${mx + uy * 5} ${my - ux * 5 - 1})`}>
                    <rect x={-6.4} y={-2.3} width={12.8} height={4.6} rx={1} className={s.cutTag} />
                    <text className={s.wireTag} textAnchor="middle" dominantBaseline="central">
                      cut t{l.downAt}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {/* your arrows for the selected packet, plus small letters for the others */}
          {[...choices].map((nid) => {
            const n = nodes.get(nid)!;
            const marks = net.packets.flatMap((p, pi) => {
              const lid = (hint && hint.packetId === p.id && hint.node === nid ? hint.link : null) ?? plan[p.id]?.[nid];
              const l = net.links.find((x) => x.id === lid);
              if (!l) return [];
              const { ux, uy } = unit(n, nodes.get(l.to)!);
              return [{ p, pi, l, ux, uy, isHint: !!hint && hint.packetId === p.id && hint.node === nid && hint.link === lid }];
            });
            return marks.map(({ p, pi, ux, uy, isHint }) => {
              if (p.id === sel || isHint) {
                const tx = n.x + ux * 10;
                const ty = n.y + uy * 10;
                const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
                return (
                  <g key={`${nid}-${p.id}`} transform={`translate(${tx} ${ty}) rotate(${ang})`}>
                    <motion.polygon
                      points="-3,-2.6 3,0 -3,2.6 -1.6,0"
                      className={`${s.arrow} ${isHint ? s.arrowHint : ''}`}
                      initial={reduce ? false : { scale: 0.4 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                    />
                  </g>
                );
              }
              const k = pi - (pi > selIdx ? 1 : 0);
              return (
                <g key={`${nid}-${p.id}`} transform={`translate(${n.x + ux * (14 + k * 3.4)} ${n.y + uy * (14 + k * 3.4) - 2.6})`} opacity={0.75}>
                  <PacketShape i={pi} r={1.4} />
                </g>
              );
            });
          })}
          {/* stops */}
          {net.nodes.map((n) => {
            const choice = choices.has(n.id);
            const unset = choice && !plan[sel]?.[n.id];
            if (n.kind === 'junction' || (n.kind === 'source' && choice)) {
              return (
                <g key={n.id}>
                  {n.kind === 'source' ? (
                    <rect x={n.x - 7} y={n.y - 4.5} width={14} height={9} rx={2} className={`${s.nodeShape} ${s.nodeSource}`} />
                  ) : (
                    <circle cx={n.x} cy={n.y} r={4.6} className={`${s.nodeShape} ${choice ? s.nodeChoice : s.nodeJunction}`} />
                  )}
                  <text x={n.x} y={n.y} className={s.nodeLabel}>
                    {unset && !play ? '?' : n.label}
                  </text>
                  {choice && (
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={8.5}
                      className={s.tapZone}
                      role="button"
                      tabIndex={0}
                      aria-label={`turn the arrow at ${n.label} for packet ${sel}`}
                      onClick={() => turn(n.id)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), turn(n.id))}
                    />
                  )}
                </g>
              );
            }
            const wanted = net.packets.filter((p) => p.to === n.id);
            return (
              <g key={n.id}>
                <rect x={n.x - 7} y={n.y - 4.5} width={14} height={9} rx={n.kind === 'server' ? 0.6 : 2} className={`${s.nodeShape} ${n.kind === 'server' ? s.nodeServer : s.nodeSource}`} />
                <text x={n.x} y={n.y} className={s.nodeLabel}>
                  {n.label}
                </text>
                {n.kind === 'server' && wanted.length > 0 && (
                  <text x={n.x} y={n.y + 8} className={s.nodeLabel} style={{ fontSize: 2.6 }}>
                    for {wanted.map((p) => p.label).join(' ')}
                  </text>
                )}
              </g>
            );
          })}
          {/* where things went wrong */}
          {badNodes.map((o) => {
            const n = nodes.get(o.node)!;
            return (
              <g key={`bad-${o.id}`}>
                <motion.circle cx={n.x} cy={n.y} r={8.5} pointerEvents="none" className={s.stuckRing} initial={reduce ? false : { scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} />
              </g>
            );
          })}
          {/* packets */}
          {net.packets.map((p, i) => {
            const pos = frame?.find((x) => x.id === p.id);
            const { x, y } = posOf(pos, i, p.id);
            const st = pos && pos.at === 'node' ? pos.state : 'idle';
            return (
              <motion.g key={p.id} initial={false} pointerEvents="none" animate={{ x, y }} transition={{ duration: reduce ? 0 : FRAME_MS / 1000 - 0.08, ease: 'linear' }}>
                <motion.g animate={st === 'waiting' && !reduce ? { rotate: [0, -12, 12, 0] } : { rotate: 0 }} transition={{ duration: 0.4 }}>
                  <PacketShape i={i} />
                  <text className={s.packetLabel}>{p.label}</text>
                </motion.g>
                {(st === 'stuck' || st === 'lost') && (
                  <text y={-4.6} className={s.stuckX}>
                    x
                  </text>
                )}
              </motion.g>
            );
          })}
        </svg>
      </div>

      <div className={s.under}>
        {net.packets.length > 1 && (
          <div className={s.packetPicker} role="radiogroup" aria-label="packet to route">
            {net.packets.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={sel === p.id}
                className={`${s.packetBtn} ${sel === p.id ? s.packetBtnOn : ''}`}
                onClick={() => (setSel(p.id), sfx.tap())}
              >
                <PacketChip i={i} label={p.label} />
                <span className={s.packetDest}>
                  to {nodeLabel(p.to)}
                  {p.departAt ? `, leaves t${p.departAt}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        {net.packets.length === 1 && (
          <p className={s.say}>
            get packet {net.packets[0]!.label} to {nodeLabel(net.packets[0]!.to)}. tap the blue junction to point its arrow.
          </p>
        )}
        {hint && (
          <p className={s.hintBox}>
            house hint: packet {hint.packetId} leaves {nodeLabel(hint.node)} on the wire to {nodeLabel(net.links.find((l) => l.id === hint.link)!.to)}.
          </p>
        )}
        {outcomes && (
          <ul className={s.outcomes} aria-live="polite">
            {outcomes.map((o) => {
              const i = net.packets.findIndex((p) => p.id === o.id);
              const l = o.link ? net.links.find((x) => x.id === o.link) : undefined;
              return (
                <li key={o.id} className={`${s.outcome} ${o.status === 'delivered' ? s.outcomeGood : s.outcomeBad}`}>
                  <PacketChip i={i} label={net.packets[i]!.label} />
                  <span>
                    {o.status === 'delivered' ? 'made it: ' : o.status === 'lost' ? 'wrong server: ' : 'stuck: '}
                    {o.reason}
                    {o.status === 'stuck' && l && !o.reason.includes(wireName(l)) ? ` (wire ${wireName(l)})` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className={s.legend}>
          a wire carries one packet at a time. 2t = takes 2 ticks. x2 = carries two. cut t2 = breaks at tick 2. earlier letters go first.
        </p>
        <div className={s.actions}>
          <Button tone="lime" size="lg" icon="play" block loading={busy} disabled={won || (!!play && !play.done)} onClick={() => void send()}>
            send
          </Button>
          <Button tone="paper" icon="undo" disabled={busy || won || (!!play && !play.done)} onClick={() => (setPlan({}), setPlay(null))} aria-label="clear arrows">
            clear
          </Button>
        </div>
      </div>
    </div>
  );
}

// Packet routing: a tiny deterministic network simulator.
//
// Used by Packet Panic (arcade rounds) and written to be reused by the four-house projector finale:
// it knows nothing about levels, points or players. Give it a network and a route plan, get back a
// tick-by-tick trace plus, for every packet, where it ended up and why.
//
// Rules (also published in the arcade):
//   - Time moves in ticks. A wire takes `length` ticks to cross (default 1).
//   - A wire carries `capacity` packets at once (default 1). A packet that finds its wire full waits
//     at the junction and tries again next tick.
//   - A wire with `downAt` breaks at that tick: nothing can enter it from then on.
//   - Packets act in list order, so when two want the same free wire, the earlier one gets it.
//   - At every junction with more than one way out, the packet follows the arrow the player set
//     for that packet. One way out needs no arrow.
//   - A packet must reach its own server by the network's deadline tick. A packet that comes back to
//     a junction it already passed would loop forever, so it is stopped right there.
// Same network + same plan = same result, always: no randomness, no clocks.
import { z } from 'zod';

export const NetNodeSchema = z.object({
  id: z.string().min(1).max(12),
  kind: z.enum(['source', 'junction', 'server']),
  /** Layout position in a 100 x 64 box. */
  x: z.number(),
  y: z.number(),
  label: z.string().max(16),
});
export type NetNode = z.infer<typeof NetNodeSchema>;

export const NetLinkSchema = z.object({
  id: z.string().min(1).max(12),
  from: z.string(),
  to: z.string(),
  length: z.number().int().min(1).max(9).optional(),
  capacity: z.number().int().min(1).max(9).optional(),
  downAt: z.number().int().min(0).optional(),
});
export type NetLink = z.infer<typeof NetLinkSchema>;

export const NetPacketSchema = z.object({
  id: z.string().min(1).max(4),
  label: z.string().max(12),
  from: z.string(),
  to: z.string(),
  departAt: z.number().int().min(0).optional(),
});
export type NetPacket = z.infer<typeof NetPacketSchema>;

export const NetworkSchema = z.object({
  nodes: z.array(NetNodeSchema).max(20),
  links: z.array(NetLinkSchema).max(40),
  packets: z.array(NetPacketSchema).min(1).max(6),
  /** Last tick a packet may arrive on. */
  deadline: z.number().int().min(1).max(40),
});
export type Network = z.infer<typeof NetworkSchema>;

/** packetId -> nodeId -> linkId: the arrow that packet follows out of that node. */
export const RoutePlanSchema = z.record(z.string().max(4), z.record(z.string().max(12), z.string().max(12)));
export type RoutePlan = z.infer<typeof RoutePlanSchema>;

/** Where one packet is at the end of a tick. */
export type PacketPos =
  | { id: string; at: 'node'; node: string; state: 'idle' | 'waiting' | 'delivered' | 'stuck' | 'lost' }
  | { id: string; at: 'link'; link: string; /** ticks spent on the wire so far, 1..length */ step: number; of: number };

export type PacketOutcome = {
  id: string;
  status: 'delivered' | 'stuck' | 'lost';
  /** Tick it arrived or got stuck. */
  tick: number;
  node: string;
  link: string | null;
  /** Short club-voice reason, e.g. "waited at J2: wire J2 to WEB was full (carrying B)". */
  reason: string;
};

export interface NetResult {
  ok: boolean;
  /** frames[t] = every packet's position at the end of tick t (t = 0..last). */
  frames: PacketPos[][];
  outcomes: PacketOutcome[];
}

const nameOf = (n: Map<string, NetNode>, id: string) => n.get(id)?.label ?? id;

/** Outgoing wires per node, in network order. */
export function outLinks(net: Network): Map<string, NetLink[]> {
  const m = new Map<string, NetLink[]>();
  for (const n of net.nodes) m.set(n.id, []);
  for (const l of net.links) m.get(l.from)?.push(l);
  return m;
}

/** Nodes where this packet needs an arrow: non-server nodes with two or more ways out. */
export function choiceNodes(net: Network): string[] {
  const outs = outLinks(net);
  return net.nodes.filter((n) => n.kind !== 'server' && (outs.get(n.id)?.length ?? 0) > 1).map((n) => n.id);
}

type Live =
  | { at: 'node'; node: string; visited: Set<string>; waiting: string | null }
  | { at: 'link'; link: NetLink; left: number; visited: Set<string> }
  | { at: 'done'; outcome: PacketOutcome };

export function simulate(net: Network, plan: RoutePlan): NetResult {
  const nodes = new Map(net.nodes.map((n) => [n.id, n]));
  const outs = outLinks(net);
  const occupancy = new Map<string, string[]>(net.links.map((l) => [l.id, []]));
  const wire = (l: NetLink) => `${nameOf(nodes, l.from)} to ${nameOf(nodes, l.to)}`;
  const state = new Map<string, Live>(net.packets.map((p) => [p.id, { at: 'node', node: p.from, visited: new Set([p.from]), waiting: null }]));
  const frames: PacketPos[][] = [];
  const finish = (p: NetPacket, outcome: Omit<PacketOutcome, 'id'>) => state.set(p.id, { at: 'done', outcome: { id: p.id, ...outcome } });

  for (let t = 0; t <= net.deadline; t++) {
    // 1. Move: everything on a wire advances; arrivals land on their node.
    for (const p of net.packets) {
      const s = state.get(p.id);
      if (s?.at !== 'link') continue;
      s.left--;
      if (s.left > 0) continue;
      const occ = occupancy.get(s.link.id);
      occ?.splice(occ.indexOf(p.id), 1);
      const node = s.link.to;
      const n = nodes.get(node);
      if (n?.kind === 'server') {
        if (node === p.to) finish(p, { status: 'delivered', tick: t, node, link: s.link.id, reason: `delivered to ${nameOf(nodes, node)} at tick ${t}` });
        else finish(p, { status: 'lost', tick: t, node, link: s.link.id, reason: `landed on ${nameOf(nodes, node)}, but it was going to ${nameOf(nodes, p.to)}` });
        continue;
      }
      if (s.visited.has(node)) {
        finish(p, { status: 'stuck', tick: t, node, link: s.link.id, reason: `came back to ${nameOf(nodes, node)}: that route is a loop` });
        continue;
      }
      s.visited.add(node);
      state.set(p.id, { at: 'node', node, visited: s.visited, waiting: null });
    }
    // 2. Depart: packets at nodes take their arrow if the wire is up and has room.
    for (const p of net.packets) {
      const s = state.get(p.id);
      if (s?.at !== 'node') continue;
      if (t < (p.departAt ?? 0)) continue;
      const ways = outs.get(s.node) ?? [];
      const chosen = ways.length === 1 ? ways[0]!.id : plan[p.id]?.[s.node];
      const l = ways.find((w) => w.id === chosen);
      if (!l) {
        finish(p, {
          status: 'stuck',
          tick: t,
          node: s.node,
          link: null,
          reason: ways.length === 0 ? `dead end at ${nameOf(nodes, s.node)}` : `no arrow set for ${p.label} at ${nameOf(nodes, s.node)}`,
        });
        continue;
      }
      if (l.downAt !== undefined && t >= l.downAt) {
        finish(p, { status: 'stuck', tick: t, node: s.node, link: l.id, reason: `wire ${wire(l)} went down at tick ${l.downAt}` });
        continue;
      }
      const occ = occupancy.get(l.id) ?? [];
      if (occ.length >= (l.capacity ?? 1)) {
        const who = occ.map((id) => net.packets.find((q) => q.id === id)?.label ?? id).join(', ');
        s.waiting = `waited at ${nameOf(nodes, s.node)}: wire ${wire(l)} was full (carrying ${who})`;
        continue;
      }
      occ.push(p.id);
      state.set(p.id, { at: 'link', link: l, left: l.length ?? 1, visited: s.visited });
    }
    // 3. Snapshot.
    frames.push(net.packets.map((p): PacketPos => framePos(p, state.get(p.id)!)));
    if ([...state.values()].every((s) => s.at === 'done')) break;
  }

  // Anyone still out there missed the deadline.
  for (const p of net.packets) {
    const s = state.get(p.id)!;
    if (s.at === 'done') continue;
    const reason =
      s.at === 'node'
        ? `${s.waiting ?? `stuck at ${nameOf(nodes, s.node)}`} until time ran out`
        : `still on wire ${wire(s.link)} when time ran out at tick ${net.deadline}`;
    finish(p, { status: 'stuck', tick: net.deadline, node: s.at === 'node' ? s.node : s.link.from, link: s.at === 'link' ? s.link.id : null, reason });
  }
  if (frames.length > 0) frames[frames.length - 1] = net.packets.map((p) => framePos(p, state.get(p.id)!));

  const outcomes = net.packets.map((p) => (state.get(p.id) as { outcome: PacketOutcome }).outcome);
  return { ok: outcomes.every((o) => o.status === 'delivered'), frames, outcomes };
}

function framePos(p: NetPacket, s: Live): PacketPos {
  if (s.at === 'link') {
    const of = s.link.length ?? 1;
    return { id: p.id, at: 'link', link: s.link.id, step: of - s.left + 1, of };
  }
  if (s.at === 'node') return { id: p.id, at: 'node', node: s.node, state: s.waiting ? 'waiting' : 'idle' };
  return { id: p.id, at: 'node', node: s.outcome.node, state: s.outcome.status };
}

/** Every complete plan for a network (each packet x each choice node). For level design and tests. */
export function* allPlans(net: Network): Generator<RoutePlan> {
  const outs = outLinks(net);
  const slots: { p: string; n: string; ways: string[] }[] = [];
  for (const p of net.packets) for (const n of choiceNodes(net)) slots.push({ p: p.id, n, ways: (outs.get(n) ?? []).map((l) => l.id) });
  const idx = slots.map(() => 0);
  for (;;) {
    const plan: RoutePlan = {};
    slots.forEach((s, i) => ((plan[s.p] ??= {})[s.n] = s.ways[idx[i]!]!));
    yield plan;
    let k = 0;
    while (k < slots.length) {
      idx[k]!++;
      if (idx[k]! < slots[k]!.ways.length) break;
      idx[k] = 0;
      k++;
    }
    if (k === slots.length) return;
  }
}

/** The plan a newcomer tries first: every packet takes its fewest-ticks path, ignoring everyone else. */
export function greedyPlan(net: Network): RoutePlan {
  const outs = outLinks(net);
  const plan: RoutePlan = {};
  for (const p of net.packets) {
    // Dijkstra on link length, backwards from the packet's server.
    const dist = new Map<string, number>([[p.to, 0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of net.links) {
        const d = dist.get(l.to);
        if (d === undefined) continue;
        const nd = d + (l.length ?? 1);
        if ((dist.get(l.from) ?? Infinity) > nd) {
          dist.set(l.from, nd);
          changed = true;
        }
      }
    }
    for (const n of choiceNodes(net)) {
      const ways = outs.get(n) ?? [];
      let best: NetLink | undefined;
      for (const l of ways) if ((dist.get(l.to) ?? Infinity) + (l.length ?? 1) < (best ? (dist.get(best.to) ?? Infinity) + (best.length ?? 1) : Infinity)) best = l;
      if (best) (plan[p.id] ??= {})[n] = best.id;
    }
  }
  return plan;
}

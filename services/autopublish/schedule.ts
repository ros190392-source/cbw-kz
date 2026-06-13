/**
 * Organic daily publishing schedule (EPIC 026).
 *
 * Instead of fixed UTC slots, each day gets a freshly randomized plan so the
 * channel reads like a human editor, not a cron job:
 *   - the NUMBER of posts varies (exchange 2–4 + global 2–4 → ~4–8/day);
 *   - the TIMES are random within an active window, never round numbers,
 *     with a minimum gap so they never bunch up;
 *   - lanes are interleaved (exchange / global / an occasional bonus).
 *
 * Everything here is pure and deterministic given a seed, so it is fully
 * unit-testable; the live tick seeds it from the date + a stored salt.
 */

export type Lane = 'exchange' | 'global' | 'bonus';
export type PlanItemStatus = 'pending' | 'posted' | 'skipped';

export interface PlanItem {
  id: string;          // `${date}#${i}`
  at: string;          // ISO time the post is due
  lane: Lane;
  status: PlanItemStatus;
  attempts: number;    // ticks that tried but found no eligible content
}

export interface DailyPlan {
  date: string;        // 'YYYY-MM-DD' (UTC)
  seed: number;
  items: PlanItem[];
}

// ── Tunables ──────────────────────────────────────────────────────────────

export const SCHEDULE = {
  windowStartH: 7,     // active window (UTC)
  windowEndH: 21,
  exMin: 2, exMax: 4,  // exchange posts per day
  glMin: 2, glMax: 4,  // global posts per day
  minGapMin: 50,       // minimum spacing between posts
  bonusChance: 0.6,    // chance one exchange slot becomes an official Bonus Alert
} as const;

/**
 * If a post is due but no eligible content turns up, keep retrying for this
 * long, then skip it (quality over quantity). Used by the tick, kept here so
 * the policy lives next to the schedule.
 */
export const ATTEMPT_WINDOW_MIN = 45;

// ── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer seed from a date string + salt. */
export function seedFromDate(dateStr: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const randInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `count` times (ms offsets from window start) that are random but at
 * least `minGapMs` apart. Stick-breaking: reserve the gaps, scatter the slack
 * randomly, then re-add the gaps — guarantees spacing and stays uniform-ish.
 */
function randomTimes(count: number, windowMs: number, minGapMs: number, rng: () => number): number[] {
  if (count <= 0) return [];
  const slack = Math.max(0, windowMs - (count - 1) * minGapMs);
  const offsets = Array.from({ length: count }, () => rng() * slack).sort((a, b) => a - b);
  return offsets.map((o, i) => Math.round(o + i * minGapMs));
}

/** Build a fresh randomized plan for the UTC day containing `now`. */
export function buildDailyPlan(now: Date, salt = 0): DailyPlan {
  const date = now.toISOString().slice(0, 10);
  const seed = seedFromDate(date, salt);
  const rng = makeRng(seed);

  const nEx = randInt(rng, SCHEDULE.exMin, SCHEDULE.exMax);
  const nGl = randInt(rng, SCHEDULE.glMin, SCHEDULE.glMax);

  // Lane bag: exchange + global, with maybe one exchange promoted to a bonus.
  const lanes: Lane[] = [
    ...Array<Lane>(nEx).fill('exchange'),
    ...Array<Lane>(nGl).fill('global'),
  ];
  if (nEx > 0 && rng() < SCHEDULE.bonusChance) lanes[0] = 'bonus';
  const shuffled = shuffle(lanes, rng);

  const windowMs = (SCHEDULE.windowEndH - SCHEDULE.windowStartH) * 3600_000;
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCHEDULE.windowStartH, 0, 0, 0);
  const times = randomTimes(shuffled.length, windowMs, SCHEDULE.minGapMin * 60_000, rng);

  const items: PlanItem[] = shuffled.map((lane, i) => ({
    id: `${date}#${i}`,
    at: new Date(startMs + times[i]).toISOString(),
    lane,
    status: 'pending',
    attempts: 0,
  }));

  return { date, seed, items };
}

/** The earliest pending item whose time has arrived, or null. */
export function nextDueItem(plan: DailyPlan, now: Date): PlanItem | null {
  const t = now.getTime();
  return plan.items
    .filter((it) => it.status === 'pending' && new Date(it.at).getTime() <= t)
    .sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

/** True once a due item has waited past the attempt window (→ should skip). */
export function isExpired(item: PlanItem, now: Date): boolean {
  return now.getTime() - new Date(item.at).getTime() > ATTEMPT_WINDOW_MIN * 60_000;
}

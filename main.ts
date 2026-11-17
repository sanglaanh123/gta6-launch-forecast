// GTA VI launch-day Twitch viewer forecaster (Node 22, standard library only).
//
// Idea: every case ships ~38 past big launches ("comparables") with their hourly Twitch viewers around release day.
// For each comparable we read its release-day curve as log ratios to its own hour-1 count, r_h = ln(v_h / v_1).
// The comparables are weighted by how much their situation at the checkpoint looks like this case's:
//   f1 = ln(hour1 / peak of the previous 24 h)   (did a rolling / early unlock already peak before UTC midnight?)
//   f2 = ln(hour1)                               (had it already unlocked by hour 1, or is a daytime unlock still due?)
// The forecast for hour h is a weighted mixture of normals centred on the comparables' r_h, with a kernel spread that
// widens over the day; its 5/25/50/75/95% quantiles are scaled back by the case's hour-1 print.
// Everything is deterministic: no randomness, no clock, inputs read in name order.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HourPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}

export interface Comparable {
  day_start: string;
  name?: string;
  unlock?: string;
  hourly: HourPoint[];
}

export interface Case {
  id: string;
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: HourPoint[];
  comparables?: Comparable[];
}

export interface Params {
  /** kernel bandwidth on the standardized features */
  bw: number;
  /** kernel spread (log units) at hour 2 */
  s0: number;
  /** extra kernel spread (log units) reached by hour 24 */
  s1: number;
  /** weight of the second feature relative to the first */
  w2: number;
  /** pull of the median toward the unweighted pooled median (0 = none) */
  shrink: number;
  /** share of the local-linear correction applied to each analogue's curve (0 = plain kernel mixture) */
  ll: number;
  /** ridge penalty of the local-linear slopes, in standardized feature units */
  lam: number;
  /** weight of an analogue whose unlock was one fixed moment (GTA VI unlocks midnight local, rolling) */
  wf: number;
  /** weight of an analogue whose unlock is not known */
  wu: number;
}

// Chosen by leave-one-out over the comparables already big at hour 1 (node eval.ts <case.in> --grid): LOO loss 0.129.
// A slightly lower 0.128 sat at the grid's edge with no widening over the day; this keeps some, for one final case.
// Round 2 (node eval.ts <case.in> --grid --rolling, scoring only big rolling-midnight launches like GTA VI): LOO 0.118
// vs 0.126 for round 1's parameters, from favouring rolling-midnight analogues and the local-linear correction. The
// grid's best (0.117) dropped fixed/unknown unlocks almost entirely; these milder weights keep them as a hedge.
export const PARAMS: Params = { bw: 0.8, s0: 0.16, s1: 0.1, w2: 10, shrink: 0, ll: 1, lam: 1, wf: 0.3, wu: 0.6 };

const HOUR = 3_600_000;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** A curve as a map from hour start (ms) to viewers. */
const toMap = (pts: HourPoint[] | undefined): Map<number, number> => {
  const m = new Map<number, number>();
  for (const p of pts ?? []) if (Number.isFinite(p.viewers) && p.viewers > 0) m.set(Date.parse(p.from), p.viewers);
  return m;
};

interface Features {
  f1: number;
  f2: number;
}

/** The checkpoint features of a curve whose hour 1 starts at t0 and prints p1. */
const features = (m: Map<number, number>, t0: number, p1: number): Features => {
  let peak = 0;
  for (let k = 1; k <= 24; k++) peak = Math.max(peak, m.get(t0 - k * HOUR) ?? 0);
  return {
    f1: peak > 0 ? Math.log(p1 / peak) : 0,
    // Size of hour 1 itself: a launch still small at hour 1 has not unlocked yet (a daytime unlock), and its later
    // hours run to 50-1000x hour 1; a launch already big at hour 1 unlocked overnight and its day stays within ~3x.
    f2: Math.log(Math.max(1, p1)),
  };
};

/** How a launch unlocked: midnight local country by country (as GTA VI does), one fixed moment, or not known. */
export type UnlockKind = 'rolling' | 'fixed' | 'unknown';
export const unlockKind = (unlock: string | undefined): UnlockKind => {
  const u = unlock ?? '';
  if (/midnight local|midnight local time|rolling|12 AM local/i.test(u)) return 'rolling';
  if (/simultaneous|single global|global unlock/i.test(u)) return 'fixed';
  return 'unknown';
};

/** Prior weight from the comparable's research tier. */
const tierWeight = (unlock: string | undefined): number => {
  const u = unlock ?? '';
  if (/Not a launch/i.test(u)) return 0;
  if (/early-access-contaminated/i.test(u)) return 0.5;
  if (/Tier: weak/i.test(u)) return 0.35;
  return 1;
};

/** An analogue's prior weight: its tier times how alike its unlock is to a rolling-midnight launch. */
const priorWeight = (a: Analogue, P: Params): number => a.w0 * (a.kind === 'rolling' ? 1 : a.kind === 'fixed' ? P.wf : P.wu);

export interface Analogue {
  w0: number;
  kind: UnlockKind;
  feat: Features;
  /** log ratio to hour 1 for hours 2..24 (index h), NaN where missing */
  r: number[];
}

/** Every usable comparable as an analogue, skipping any on the case's own day. */
export const analogues = (comps: Comparable[], skipDayStart?: string): Analogue[] => {
  const out: Analogue[] = [];
  for (const c of comps) {
    if (skipDayStart !== undefined && c.day_start === skipDayStart) continue;
    const w0 = tierWeight(c.unlock);
    if (w0 <= 0) continue;
    const m = toMap(c.hourly);
    const t0 = Date.parse(c.day_start);
    const p1 = m.get(t0);
    if (p1 === undefined || p1 < 50) continue;
    const r: number[] = new Array(25).fill(NaN);
    let have = 0;
    for (let h = 2; h <= 24; h++) {
      const v = m.get(t0 + (h - 1) * HOUR);
      if (v !== undefined) {
        r[h] = Math.log(v / p1);
        have++;
      }
    }
    if (have < 16) continue;
    // Fill the few missing hours by linear interpolation in log space, so each analogue speaks for every hour.
    for (let h = 2; h <= 24; h++) {
      if (!Number.isNaN(r[h])) continue;
      let a = h - 1;
      while (a >= 2 && Number.isNaN(r[a])) a--;
      let b = h + 1;
      while (b <= 24 && Number.isNaN(r[b])) b++;
      const ra = a >= 2 ? r[a] : 0;
      const ia = a >= 2 ? a : 1;
      r[h] = b <= 24 ? ra + ((r[b] - ra) * (h - ia)) / (b - ia) : ra;
    }
    out.push({ w0, kind: unlockKind(c.unlock), feat: features(m, t0, p1), r });
  }
  return out;
};

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7). */
const phi = (x: number): number => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};

/** Quantile tau of a weighted mixture of normals N(xs[i], s^2). */
const mixQuantile = (xs: number[], ws: number[], s: number, tau: number): number => {
  let lo = Math.min(...xs) - 8 * s;
  let hi = Math.max(...xs) + 8 * s;
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    let cdf = 0;
    for (let i = 0; i < xs.length; i++) cdf += ws[i] * phi((mid - xs[i]) / s);
    if (cdf < tau) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Weighted median of xs. */
const wMedian = (xs: number[], ws: number[]): number => {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= 0.5) return xs[i];
  }
  return xs[idx[idx.length - 1]];
};

/** Log-ratio quantiles (to hour 1) for hours 2..24 of a case with features f, from the analogues. */
export const logQuantiles = (an: Analogue[], f: Features, P: Params): number[][] => {
  // Standardize the features over the analogues so the bandwidth is unit-free.
  const sd = (k: 'f1' | 'f2'): number => {
    const v = an.map((a) => a.feat[k]);
    const mu = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.max(0.05, Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length));
  };
  const s1 = sd('f1');
  const s2 = sd('f2');
  let ws = an.map((a) => {
    const d1 = (a.feat.f1 - f.f1) / s1;
    const d2 = (a.feat.f2 - f.f2) / s2;
    return priorWeight(a, P) * Math.exp(-(d1 * d1 + P.w2 * d2 * d2) / (2 * P.bw * P.bw));
  });
  let tot = ws.reduce((s, x) => s + x, 0);
  if (!(tot > 1e-12)) {
    ws = an.map((a) => priorWeight(a, P));
    tot = ws.reduce((s, x) => s + x, 0);
  }
  ws = ws.map((w) => w / tot);
  const flat = an.map((a) => priorWeight(a, P));
  const flatTot = flat.reduce((s, x) => s + x, 0);
  const flatW = flat.map((w) => w / flatTot);

  // Standardized feature offsets of each analogue from the case, for the local-linear correction.
  const u1 = an.map((a) => (a.feat.f1 - f.f1) / s1);
  const u2 = an.map((a) => (a.feat.f2 - f.f2) / s2);

  const rows: number[][] = [];
  for (let h = 2; h <= 24; h++) {
    let xs = an.map((a) => a.r[h]);
    if (P.ll > 0) {
      // Weighted ridge regression r = a + b1 u1 + b2 u2 around the case; move each analogue's ratio to the case's
      // features (subtract b.u), so analogues that differ from the case still say something about it.
      let sw = 0, m1 = 0, m2 = 0, my = 0;
      for (let i = 0; i < an.length; i++) {
        sw += ws[i]; m1 += ws[i] * u1[i]; m2 += ws[i] * u2[i]; my += ws[i] * xs[i];
      }
      m1 /= sw; m2 /= sw; my /= sw;
      let a11 = P.lam, a22 = P.lam, a12 = 0, c1 = 0, c2 = 0;
      for (let i = 0; i < an.length; i++) {
        const d1 = u1[i] - m1, d2 = u2[i] - m2, dy = xs[i] - my;
        a11 += ws[i] * d1 * d1; a22 += ws[i] * d2 * d2; a12 += ws[i] * d1 * d2;
        c1 += ws[i] * d1 * dy; c2 += ws[i] * d2 * dy;
      }
      const det = a11 * a22 - a12 * a12;
      const b1 = (a22 * c1 - a12 * c2) / det;
      const b2 = (a11 * c2 - a12 * c1) / det;
      xs = xs.map((x, i) => x - P.ll * (b1 * u1[i] + b2 * u2[i]));
    }
    const shift = P.shrink * (wMedian(xs, flatW) - wMedian(xs, ws));
    const s = P.s0 + (P.s1 * (h - 2)) / 22;
    rows.push(LEVELS.map((tau) => mixQuantile(xs, ws, s, tau) + shift));
  }
  return rows;
};

/** The forecast rows of one case. */
export const forecastCase = (c: Case, P: Params = PARAMS, skipOwnDay = true): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${c.id} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const an = analogues(c.comparables ?? [], skipOwnDay ? c.day_start : undefined);
  const want = c.forecast.map((f) => f.hour);
  if (an.length < 3) {
    // Fallback: the house persistence shape, widened.
    const Z = [-1.645, -0.674, 0, 0.674, 1.645];
    return want.map((hour) => ({ hour, q: Z.map((z) => round2(p1 * Math.exp(z * 0.25 * Math.sqrt(hour - 1)))) }));
  }
  const t0 = Date.parse(c.day_start);
  const f = features(toMap(c.history_hourly), t0, p1);
  const rows = logQuantiles(an, f, P);
  return want.map((hour) => {
    const lq = rows[hour - 2];
    let prev = 0;
    const q = lq.map((x) => {
      const v = Math.min(1e9, Math.max(0.01, round2(p1 * Math.exp(x))));
      prev = Math.max(prev, v);
      return prev;
    });
    return { hour, q };
  });
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('/main.ts');
if (isMain) {
  const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    const hours = forecastCase(c);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
  }
}

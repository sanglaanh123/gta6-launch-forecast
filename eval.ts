// Leave-one-out check of the forecaster on the comparables a case ships: each comparable in turn is the target,
// forecast from the others, and scored with the contest's loss (mean pinball loss on the log scale over hours 2..24
// and the five levels). Also grid-searches the parameters.
//
//   node eval.ts <case.in> [--grid]

import { readFileSync } from 'node:fs';
import { analogues, logQuantiles, PARAMS, type Analogue, type Case, type Params } from './main.ts';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

const ROLLING_ONLY = process.argv.includes('--rolling');

const pinball = (y: number, q: number, tau: number): number => (y >= q ? tau * (y - q) : (1 - tau) * (q - y));

/** Mean LOO loss over every analogue, and the per-analogue losses. */
export const looLoss = (an: Analogue[], P: Params, rollingOnly = ROLLING_ONLY): { mean: number; each: number[] } => {
  const each: number[] = [];
  for (let i = 0; i < an.length; i++) {
    // Score only launches already big at hour 1 (>= 20k viewers): the regime of the practice cases and of GTA VI;
    // with --rolling, only those that unlocked at midnight local, as GTA VI and every practice launch do.
    if (an[i].feat.f2 < Math.log(20000)) continue;
    if (rollingOnly && an[i].kind !== 'rolling') continue;
    const rest = an.filter((_, j) => j !== i);
    const rows = logQuantiles(rest, an[i].feat, P);
    let s = 0;
    let n = 0;
    for (let h = 2; h <= 24; h++) {
      const y = an[i].r[h];
      rows[h - 2].forEach((q, k) => {
        s += pinball(y, q, LEVELS[k]);
        n++;
      });
    }
    each.push(s / n);
  }
  return { mean: each.reduce((a, b) => a + b, 0) / each.length, each };
};

const file = process.argv[2] ?? 'input/p00.in';
const c = JSON.parse(readFileSync(file, 'utf8')) as Case;
const an = analogues(c.comparables ?? []);
console.log(`analogues: ${an.length}`);
console.log(`LOO loss with PARAMS ${JSON.stringify(PARAMS)}: ${looLoss(an, PARAMS).mean.toFixed(4)}`);

if (process.argv.includes('--grid')) {
  let best = { loss: Infinity, P: PARAMS };
  for (const bw of [0.8, 1.2, 2])
    for (const s0 of [0.14, 0.2, 0.26])
      for (const s1 of [0.1, 0.25])
        for (const w2 of [4, 10])
          for (const [ll, lam] of [[0, 1], [1, 1]])
            for (const [wf, wu] of [[1, 1], [0.3, 0.6], [0.1, 0.4], [0.05, 0.2]]) {
            const P = { bw, s0, s1, w2, shrink: 0, ll, lam, wf, wu };
            const loss = looLoss(an, P).mean;
            if (loss < best.loss) best = { loss, P };
          }
  console.log(`best: ${best.loss.toFixed(4)} ${JSON.stringify(best.P)}`);
}

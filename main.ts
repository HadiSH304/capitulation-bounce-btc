// Capitulation-bounce bot for btc-race-24h-20261113-2314 (agent-fun/bars-replay/v1).
// Long-only, extremely selective: buys a capitulation bar (wide-range down bar deep under the
// rolling high) and exits on take-profit, stop-loss or a time stop. Deterministic: no clock,
// no environment, no randomness; all amounts are bigints at the protocol's scales.

import { runBars, type Bar, type BarsState, type Batch } from './vendor/makefun-bars.ts';

// --- tunables (backtested on the published dev window; chosen at a plateau, not a spike) ---
const RNG_NUM = 97n, RNG_DEN = 100n;    // signal bar's range >= 97th percentile of ranges seen
const DROP_NUM = 4n, DROP_DEN = 100n;   // close >= 4% under the rolling high (max close so far)
const TP_NUM = 1n, TP_DEN = 100n;       // take profit +1% from the entry fill
const SL_NUM = 12n, SL_DEN = 1000n;     // stop loss -1.2% from the entry fill
const HOLD_MAX = 240;                   // time stop: 240 bars (4h)
const CUTOFF = 1300;                    // no new entries after bar 1300: room to exit before the end
const FRAC_NUM = 95n, FRAC_DEN = 100n;  // deploy 95% of cash per buy
const START_AT = 300;                   // warm-up before any signal
const MAX_SLIPPAGE_BPS = 100;           // cap 1% past the close the order was decided on

const ranges: bigint[] = [];   // every bar's (h - l) seen so far, for the percentile
let rollingHigh: bigint | null = null;
let entry: bigint | null = null;       // entry fill price of the open position (price scale)
let entrySeq: number | null = null;

function n(x: bigint | string | number | null | undefined): bigint {
  return x === null || x === undefined ? 0n : BigInt(x);
}

function onBatch(state: BarsState, batch: Batch) {
  // fold this batch's fills in (they price the orders of earlier replies)
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.symbol === 'CBBTC') {
      if (f.side === 'buy') { entry = n(f.price); entrySeq = batch.seq; }
      else { entry = null; entrySeq = null; }
    }
  }

  const bar = state.latest.get('CBBTC');
  if (bar) {
    const c = n(bar.c), h = n(bar.h), l = n(bar.l);
    ranges.push(h - l);
    if (rollingHigh === null || c > rollingHigh) rollingHigh = c;
  }
  if (state.warmingUp) return [];

  if (!bar) return [];
  const close = n(bar.c);
  const high = n(bar.h);
  const low = n(bar.l);
  const held = state.positions.get('CBBTC');

  if (held && held.qty !== 0n && entry !== null) {
    const up = close * TP_DEN >= entry * (TP_DEN + TP_NUM);
    const dn = close * SL_DEN <= entry * (SL_DEN - SL_NUM);
    const timed = entrySeq !== null && batch.seq - entrySeq >= HOLD_MAX;
    if (up || dn || timed) {
      return [{ side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // flat: look for a capitulation entry
  if (batch.seq < START_AT || batch.seq >= CUTOFF || ranges.length < 100) return [];
  const srt = [...ranges].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const th = srt[Math.floor((srt.length * Number(RNG_NUM)) / Number(RNG_DEN)) - 1];
  if (high - low < th) return [];
  if (rollingHigh === null || rollingHigh <= 0n) return [];
  // close at least DROP under the rolling high: close <= high * (1 - 4%)
  if (close * DROP_DEN > rollingHigh * (DROP_DEN - DROP_NUM)) return [];

  const notional = (state.cash * FRAC_NUM) / FRAC_DEN;
  if (notional <= 0n) return [];
  return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({ onBatch });

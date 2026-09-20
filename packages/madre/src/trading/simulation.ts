/**
 * Trading research: simulation only.
 *
 * This module evaluates strategies against price series the user supplies. It
 * has no market connection, no order type and no account. `LiveExecutionGuard`
 * exists to make the boundary explicit: any attempt to place a real order
 * throws. A backtest is a description of the past, not a forecast, and every
 * result carries that caveat.
 */

export interface Bar {
  t: string;
  close: number;
}

export interface BacktestConfig {
  bars: Bar[];
  /** Signal: +1 long, 0 flat, computed from bars up to and including index i. */
  signal: (closes: number[], i: number) => 0 | 1;
  startingCash: number;
  /** Cost per trade as a fraction of traded value (e.g. 0.001 = 0.1%). */
  feeRate: number;
}

export interface Trade {
  enteredAt: string;
  exitedAt: string;
  entry: number;
  exit: number;
  returnPct: number;
}

export interface BacktestResult {
  mode: 'simulation';
  trades: Trade[];
  endingEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRate: number | null;
  caveats: string[];
}

export function backtest(cfg: BacktestConfig): BacktestResult {
  if (cfg.startingCash <= 0) throw new RangeError('El capital inicial (startingCash) debe ser positivo.');
  if (cfg.feeRate < 0 || cfg.feeRate >= 1) throw new RangeError('La comisión (feeRate) debe estar en el intervalo [0, 1).');
  const closes = cfg.bars.map((b) => b.close);
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) throw new RangeError('Todos los cierres deben ser números positivos.');

  let cash = cfg.startingCash;
  let units = 0;
  let entry: { price: number; t: string } | null = null;
  let peak = cfg.startingCash;
  let maxDd = 0;
  const trades: Trade[] = [];

  // Signal at bar i is acted on at bar i+1's close, so it never uses the price it trades on.
  const desired: (0 | 1)[] = cfg.bars.map((_, i) => cfg.signal(closes.slice(0, i + 1), i));
  for (let i = 1; i < cfg.bars.length; i++) {
    const bar = cfg.bars[i]!;
    const want = desired[i - 1]!;
    if (want === 1 && units === 0) {
      const spend = cash * (1 - cfg.feeRate);
      units = spend / bar.close;
      cash = 0;
      entry = { price: bar.close, t: bar.t };
    } else if (want === 0 && units > 0 && entry !== null) {
      cash = units * bar.close * (1 - cfg.feeRate);
      trades.push({ enteredAt: entry.t, exitedAt: bar.t, entry: entry.price, exit: bar.close, returnPct: (bar.close / entry.price - 1) * 100 });
      units = 0;
      entry = null;
    }
    const equity = cash + units * bar.close;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const last = cfg.bars[cfg.bars.length - 1];
  const endingEquity = cash + (last === undefined ? 0 : units * last.close);
  const wins = trades.filter((t) => t.returnPct > 0).length;

  return {
    mode: 'simulation',
    trades,
    endingEquity,
    totalReturnPct: (endingEquity / cfg.startingCash - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    winRate: trades.length === 0 ? null : wins / trades.length,
    caveats: [
      'Esto es una simulación sobre datos históricos aportados. No predice resultados futuros.',
      trades.length < 30
        ? `Solo ${trades.length} ${trades.length === 1 ? 'operación' : 'operaciones'}: demasiado pocas para afirmar que el resultado sea algo más que azar.`
        : 'Ajustar una estrategia a datos pasados exagera lo que habría hecho sobre datos no vistos.',
      'El deslizamiento, la liquidez, los impuestos y los retrasos de ejecución no se modelan más allá de la comisión.',
    ],
  };
}

/** Kelly fraction, floored at 0 and capped, because full Kelly is aggressive on estimated inputs. */
export function cappedKelly(winProbability: number, payoffRatio: number, cap = 0.25): number {
  if (!(winProbability >= 0 && winProbability <= 1) || !(payoffRatio > 0)) throw new RangeError('Los datos de entrada de Kelly no son válidos.');
  const f = winProbability - (1 - winProbability) / payoffRatio;
  return Math.min(Math.max(f, 0), cap);
}

/** Beta-Binomial posterior for a win rate, with a uniform prior by default. */
export function updateBeta(prior: { alpha: number; beta: number }, wins: number, losses: number): { alpha: number; beta: number; mean: number } {
  const alpha = prior.alpha + wins;
  const beta = prior.beta + losses;
  return { alpha, beta, mean: alpha / (alpha + beta) };
}

export class LiveTradingForbiddenError extends Error {
  constructor() {
    super('La operativa real no está disponible. MADRE solo admite investigación de trading en simulación: no se puede enviar ninguna orden.');
    this.name = 'LiveTradingForbiddenError';
  }
}

/** Every method refuses. There is deliberately no way to configure it otherwise. */
export const LiveExecutionGuard = Object.freeze({
  connected: false as const,
  placeOrder(): never {
    throw new LiveTradingForbiddenError();
  },
  cancelOrder(): never {
    throw new LiveTradingForbiddenError();
  },
  connect(): never {
    throw new LiveTradingForbiddenError();
  },
});

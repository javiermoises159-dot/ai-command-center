/**
 * Affiliate and growth engine.
 *
 * Commission percentages are never invented here. Every rate comes from a
 * `CommissionProgram` the operator configured; with no program there is no
 * rate and no commission. Money is handled in integer cents so splits add up
 * exactly. Payouts are only *computed* into a ledger — actually paying anyone
 * is a FINANCIAL action that this module has no way to perform.
 */

export type Attribution = 'first_touch' | 'last_touch' | 'linear';

/** Etiquetas en español de los modelos de atribución. El valor de enumeración no cambia. */
export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  first_touch: 'al primer contacto',
  last_touch: 'al último contacto',
  linear: 'lineal',
};

export interface CommissionTier {
  /** Applies from this many attributed sales (inclusive). */
  fromSales: number;
  /** Fraction of the sale, 0..1, in basis points to stay exact (1000 = 10%). */
  rateBp: number;
}

export interface CommissionProgram {
  id: string;
  name: string;
  attribution: Attribution;
  tiers: CommissionTier[];
  /** Rate for a parent affiliate on a sub-affiliate's sale, in basis points. Optional. */
  overrideBp?: number;
  /** Days a sale stays refundable before a commission can become payable. */
  holdDays: number;
}

export interface Touch {
  affiliateId: string;
  at: string;
}

export interface Sale {
  id: string;
  amountCents: number;
  currency: string;
  at: string;
  /** Ordered touches that led to the sale. */
  touches: Touch[];
  refundedCents?: number;
}

export type LedgerState = 'pending' | 'payable' | 'reversed' | 'payout_requested';

export interface LedgerEntry {
  saleId: string;
  affiliateId: string;
  amountCents: number;
  currency: string;
  rateBp: number;
  state: LedgerState;
  payableAfter: string;
  note: string;
}

export class AffiliateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AffiliateConfigError';
  }
}

export function validateProgram(program: CommissionProgram, parents: Record<string, string> = {}): string[] {
  const problems: string[] = [];
  if (program.tiers.length === 0) problems.push('El programa no tiene tramos de comisión, así que no se puede calcular ninguna comisión.');
  const sorted = [...program.tiers].sort((a, b) => a.fromSales - b.fromSales);
  if (sorted[0] !== undefined && sorted[0].fromSales !== 0) problems.push('El primer tramo debe empezar en 0 ventas.');
  for (const t of program.tiers) {
    if (!Number.isInteger(t.rateBp) || t.rateBp < 0 || t.rateBp > 10_000) problems.push(`El tramo a partir de ${t.fromSales} ${t.fromSales === 1 ? 'venta' : 'ventas'} tiene un porcentaje no válido.`);
  }
  const top = Math.max(0, ...program.tiers.map((t) => t.rateBp));
  const override = program.overrideBp ?? 0;
  if (override < 0) problems.push('El porcentaje de override no puede ser negativo.');
  if (top + override > 10_000 && Object.keys(parents).length > 0) problems.push('La comisión del afiliado más el override puede superar el 100 % de una venta.');
  if (program.holdDays < 0) problems.push('El periodo de retención (holdDays) no puede ser negativo.');
  return problems;
}

function rateFor(program: CommissionProgram, priorSales: number): number {
  let rate = 0;
  for (const t of [...program.tiers].sort((a, b) => a.fromSales - b.fromSales)) if (priorSales >= t.fromSales) rate = t.rateBp;
  return rate;
}

/** Split `total` cents by integer weights so the parts always sum to `total`. */
export function splitCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % raw.length, remainder--) raw[i] = (raw[i] ?? 0) + 1;
  return raw;
}

function creditShares(program: CommissionProgram, sale: Sale): { affiliateId: string; weight: number }[] {
  if (sale.touches.length === 0) return [];
  const ordered = [...sale.touches].sort((a, b) => a.at.localeCompare(b.at));
  if (program.attribution === 'first_touch') return [{ affiliateId: ordered[0]!.affiliateId, weight: 1 }];
  if (program.attribution === 'last_touch') return [{ affiliateId: ordered[ordered.length - 1]!.affiliateId, weight: 1 }];
  const byAffiliate = new Map<string, number>();
  for (const t of ordered) byAffiliate.set(t.affiliateId, (byAffiliate.get(t.affiliateId) ?? 0) + 1);
  return [...byAffiliate].map(([affiliateId, weight]) => ({ affiliateId, weight }));
}

export interface ComputeOptions {
  program: CommissionProgram;
  sales: Sale[];
  /** Child affiliate id → parent affiliate id. */
  parents?: Record<string, string>;
  now: string;
}

/** Computes commissions from sales using only the configured program. Pure. */
export function computeCommissions(opts: ComputeOptions): LedgerEntry[] {
  const { program, parents = {}, now } = opts;
  const problems = validateProgram(program, parents);
  if (problems.length > 0) throw new AffiliateConfigError(problems.join(' '));

  const counts = new Map<string, number>();
  const ledger: LedgerEntry[] = [];
  const sales = [...opts.sales].sort((a, b) => a.at.localeCompare(b.at));

  for (const sale of sales) {
    const net = Math.max(0, sale.amountCents - (sale.refundedCents ?? 0));
    const shares = creditShares(program, sale);
    const payableAfter = new Date(new Date(sale.at).getTime() + program.holdDays * 86_400_000).toISOString();
    const fullyRefunded = net === 0;
    const state: LedgerState = fullyRefunded ? 'reversed' : new Date(now) >= new Date(payableAfter) ? 'payable' : 'pending';
    if (shares.length === 0) continue;

    // The commissionable base is split among credited affiliates first; each
    // affiliate's tier is looked up from their own count of prior sales.
    const bases = splitCents(net, shares.map((s) => s.weight));
    shares.forEach((share, i) => {
      const prior = counts.get(share.affiliateId) ?? 0;
      counts.set(share.affiliateId, prior + 1);
      const rateBp = rateFor(program, prior);
      const commission = Math.floor(((bases[i] ?? 0) * rateBp) / 10_000);
      ledger.push({
        saleId: sale.id, affiliateId: share.affiliateId, amountCents: commission, currency: sale.currency, rateBp, state, payableAfter,
        note: fullyRefunded ? 'Venta reembolsada por completo; comisión revertida.' : `Atribución ${ATTRIBUTION_LABEL[program.attribution]} en el tramo configurado del ${rateBp / 100} %.`,
      });
      const parent = parents[share.affiliateId];
      if (parent !== undefined && (program.overrideBp ?? 0) > 0) {
        const bp = program.overrideBp ?? 0;
        ledger.push({
          saleId: sale.id, affiliateId: parent, amountCents: Math.floor(((bases[i] ?? 0) * bp) / 10_000), currency: sale.currency, rateBp: bp, state, payableAfter,
          note: `Override sobre la venta de un subafiliado, al ${bp / 100} % configurado.`,
        });
      }
    });
  }
  return ledger;
}

export interface PayoutRequest {
  affiliateId: string;
  currency: string;
  totalCents: number;
  entries: LedgerEntry[];
  /** A payout is a FINANCIAL action: it is a request for approval, never a transfer. */
  permission: 'FINANCIAL';
  executed: false;
}

/** Groups payable entries into payout *requests*. Nothing is paid. */
export function preparePayouts(ledger: LedgerEntry[], minimumCents = 0): PayoutRequest[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of ledger) {
    if (e.state !== 'payable') continue;
    const key = `${e.affiliateId}|${e.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: PayoutRequest[] = [];
  for (const entries of groups.values()) {
    const first = entries[0]!;
    const total = entries.reduce((a, e) => a + e.amountCents, 0);
    if (total > 0 && total >= minimumCents) out.push({ affiliateId: first.affiliateId, currency: first.currency, totalCents: total, entries, permission: 'FINANCIAL', executed: false });
  }
  return out;
}

/** With no configured program there is nothing to compute — and no rate to guess. */
export function describeWithoutProgram(): string {
  return 'No hay ningún programa de comisiones configurado. MADRE no da por supuestos los porcentajes de comisión; añade un programa con tus propios tramos para calcularlas.';
}

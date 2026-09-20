/**
 * Permission policy.
 *
 * Every action that touches the world beyond MADRE's own stores is described as
 * a `PermissionRequest` and answered with AUTO, ASK or BLOCK.
 *
 * Invariants, enforced in code and covered by tests:
 *  - FINANCIAL and PUBLISH are never AUTO.
 *  - EXTERNAL_ACTION and DELETE are never AUTO.
 *  - EXECUTE is BLOCK by default (nothing executes arbitrary code yet).
 *  - Operator overrides can only make a level stricter, or loosen it up to its
 *    "floor" (the loosest mode allowed for that level) — never past it.
 *  - An action that moves money is treated as FINANCIAL whatever it is called.
 */

import type { PermissionDecision, PermissionLevel, PermissionMode, PermissionRequest } from '../types.ts';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = [
  'READ',
  'WRITE',
  'EXECUTE',
  'EXTERNAL_ACTION',
  'FINANCIAL',
  'PUBLISH',
  'DELETE',
];

const RANK: Record<PermissionMode, number> = { AUTO: 0, ASK: 1, BLOCK: 2 };

/** What each level is set to unless the operator says otherwise. */
export const DEFAULT_MODES: Record<PermissionLevel, PermissionMode> = {
  READ: 'AUTO',
  WRITE: 'AUTO',
  EXECUTE: 'BLOCK',
  EXTERNAL_ACTION: 'ASK',
  FINANCIAL: 'BLOCK',
  PUBLISH: 'ASK',
  DELETE: 'ASK',
};

/** The loosest mode an override may reach for each level. */
export const LOOSEST_MODES: Record<PermissionLevel, PermissionMode> = {
  READ: 'AUTO',
  WRITE: 'AUTO',
  EXECUTE: 'ASK',
  EXTERNAL_ACTION: 'ASK',
  FINANCIAL: 'ASK',
  PUBLISH: 'ASK',
  DELETE: 'ASK',
};

function stricter(a: PermissionMode, b: PermissionMode): PermissionMode {
  return RANK[a] >= RANK[b] ? a : b;
}

export class PermissionPolicy {
  private readonly modes: Record<PermissionLevel, PermissionMode>;

  constructor(overrides: Partial<Record<PermissionLevel, PermissionMode>> = {}) {
    this.modes = { ...DEFAULT_MODES };
    for (const level of PERMISSION_LEVELS) {
      const requested = overrides[level];
      if (requested === undefined) continue;
      // Never looser than the floor for that level.
      this.modes[level] = stricter(requested, LOOSEST_MODES[level]);
    }
  }

  /** The configured mode per level, for display. */
  configured(): Record<PermissionLevel, PermissionMode> {
    return { ...this.modes };
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    let level = request.level;
    const notes: string[] = [];

    if (request.amountUsd !== undefined && request.amountUsd > 0 && level !== 'FINANCIAL') {
      notes.push(`mueve ${request.amountUsd} USD, así que se trata como FINANCIAL`);
      level = 'FINANCIAL';
    }

    let mode = this.modes[level];

    // Writing inside MADRE's own stores is routine; writing anywhere else is not.
    if (level === 'WRITE' && request.internal !== true) {
      mode = stricter(mode, 'ASK');
      notes.push('la escritura sale de los almacenes propios de MADRE');
    }

    // Hard invariants, applied last so no path above can weaken them.
    if (level === 'FINANCIAL' || level === 'PUBLISH' || level === 'EXTERNAL_ACTION' || level === 'DELETE') {
      mode = stricter(mode, 'ASK');
    }
    if (level === 'EXECUTE') mode = stricter(mode, this.modes.EXECUTE);

    const base = `${level} está en ${mode} para «${request.subject}»`;
    return { mode, level, reason: notes.length > 0 ? `${base}: ${notes.join('; ')}.` : `${base}.` };
  }
}

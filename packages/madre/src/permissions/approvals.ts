/**
 * Human approvals. A step that needs a person's decision creates an
 * `ApprovalRequest` and the run pauses. Deciding is idempotent-safe: an
 * approval can only move out of `pending` once.
 */

import { newId } from '@acc/domain';

import { KINDS, type MadreStore } from '../store.ts';
import type { ApprovalRequest, PermissionLevel } from '../types.ts';

export interface NewApproval {
  missionId: string;
  runId: string;
  stepId: string | null;
  kind: ApprovalRequest['kind'];
  level: PermissionLevel | null;
  title: string;
  detail: string;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_decided',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export class ApprovalService {
  constructor(private readonly store: MadreStore) {}

  async request(input: NewApproval): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: newId(),
      ...input,
      status: 'pending',
      createdAt: this.store.clock.now().toISOString(),
      decidedAt: null,
      note: null,
    };
    await this.store.put(KINDS.approval, approval.id, approval, { missionId: approval.missionId, runId: approval.runId });
    return approval;
  }

  get(id: string): Promise<ApprovalRequest | null> {
    return this.store.get<ApprovalRequest>(KINDS.approval, id);
  }

  async decide(id: string, decision: 'approved' | 'denied', note: string | null = null): Promise<ApprovalRequest> {
    const current = await this.get(id);
    if (current === null) throw new ApprovalError('not_found', `La solicitud de aprobación ${id} no existe.`);
    if (current.status !== 'pending') {
      throw new ApprovalError('already_decided', `La solicitud de aprobación ${id} ya se había resuelto (${current.status}).`);
    }
    const next: ApprovalRequest = {
      ...current,
      status: decision,
      note: note ?? current.note,
      decidedAt: this.store.clock.now().toISOString(),
    };
    await this.store.put(KINDS.approval, id, next, { missionId: next.missionId, runId: next.runId });
    return next;
  }

  forRun(runId: string): Promise<ApprovalRequest[]> {
    return this.store.list<ApprovalRequest>(KINDS.approval, { runId, order: 'asc' });
  }

  forMission(missionId: string): Promise<ApprovalRequest[]> {
    return this.store.list<ApprovalRequest>(KINDS.approval, { missionId, order: 'asc' });
  }

  async pending(limit = 100): Promise<ApprovalRequest[]> {
    const all = await this.store.list<ApprovalRequest>(KINDS.approval, { order: 'desc', limit: 500 });
    return all.filter((a) => a.status === 'pending').slice(0, limit);
  }
}

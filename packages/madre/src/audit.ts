/**
 * Audit log. Every decision MADRE makes on its own — compiling, routing,
 * refusing, retrying, approving — is written here so a person can reconstruct
 * what happened and why. Audit writes never throw: a failing log must not fail
 * the mission it describes.
 */

import { newId } from '@acc/domain';

import { KINDS, type MadreStore } from './store.ts';
import type { AuditActor, AuditEvent } from './types.ts';

export interface AuditContext {
  missionId?: string | null;
  runId?: string | null;
  stepId?: string | null;
}

export class AuditLog {
  constructor(private readonly store: MadreStore) {}

  async record(
    actor: AuditActor,
    type: string,
    message: string,
    context: AuditContext = {},
    data: Record<string, unknown> | null = null,
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: newId(),
      at: this.store.clock.now().toISOString(),
      actor,
      type,
      message,
      missionId: context.missionId ?? null,
      runId: context.runId ?? null,
      stepId: context.stepId ?? null,
      data,
    };
    try {
      await this.store.put(KINDS.audit, event.id, event, { missionId: event.missionId, runId: event.runId });
    } catch {
      // Deliberately swallowed: see the module note.
    }
    return event;
  }

  /**
   * Record an event under a fixed id, once. A second call with the same id
   * changes nothing and returns the event already stored, so an operation that
   * may run twice (boot-time recovery) leaves one event, not two.
   */
  async recordOnce(
    id: string,
    actor: AuditActor,
    type: string,
    message: string,
    context: AuditContext = {},
    data: Record<string, unknown> | null = null,
  ): Promise<AuditEvent> {
    try {
      const existing = await this.store.get<AuditEvent>(KINDS.audit, id);
      if (existing !== null) return existing;
    } catch {
      // Cannot tell: fall through and write. A duplicate is better than a lost record.
    }
    const event: AuditEvent = {
      id,
      at: this.store.clock.now().toISOString(),
      actor,
      type,
      message,
      missionId: context.missionId ?? null,
      runId: context.runId ?? null,
      stepId: context.stepId ?? null,
      data,
    };
    try {
      await this.store.put(KINDS.audit, id, event, { missionId: event.missionId, runId: event.runId });
    } catch {
      // Deliberately swallowed: see the module note.
    }
    return event;
  }

  forMission(missionId: string, limit = 200): Promise<AuditEvent[]> {
    return this.store.list<AuditEvent>(KINDS.audit, { missionId, limit, order: 'asc' });
  }

  recent(limit = 100): Promise<AuditEvent[]> {
    return this.store.list<AuditEvent>(KINDS.audit, { limit, order: 'desc' });
  }
}

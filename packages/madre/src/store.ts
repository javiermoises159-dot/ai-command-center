/**
 * Typed access to MADRE's documents.
 *
 * Everything MADRE persists is a JSON document in the generic document store,
 * keyed by (kind, id). This wrapper fixes the kinds, converts dates, and keeps
 * the rest of the package from knowing anything about the storage engine.
 */

import type { DocumentQuery, DocumentStore, StoredDocument } from '@acc/domain';

import { systemClock, type Clock } from './util.ts';

export const KINDS = {
  plan: 'madre.plan',
  runState: 'madre.run_state',
  qa: 'madre.qa',
  cost: 'madre.cost',
  audit: 'madre.audit',
  memory: 'madre.memory',
  approval: 'madre.approval',
  settings: 'madre.settings',
} as const;

export type Kind = (typeof KINDS)[keyof typeof KINDS];

export interface PutContext {
  missionId?: string | null;
  runId?: string | null;
  scope?: string | null;
}

export interface Stamped<T> {
  payload: T;
  createdAt: Date;
  updatedAt: Date;
  missionId: string | null;
  runId: string | null;
  scope: string | null;
}

export class MadreStore {
  constructor(
    private readonly docs: DocumentStore,
    readonly clock: Clock = systemClock,
  ) {}

  async put<T>(kind: Kind, id: string, payload: T, context: PutContext = {}): Promise<void> {
    await this.docs.put({
      kind,
      id,
      missionId: context.missionId ?? null,
      runId: context.runId ?? null,
      scope: context.scope ?? null,
      payload,
      at: this.clock.now(),
    });
  }

  async get<T>(kind: Kind, id: string): Promise<T | null> {
    const doc = await this.docs.get(kind, id);
    return doc === null ? null : (doc.payload as T);
  }

  async list<T>(kind: Kind, query: Omit<DocumentQuery, 'kind'> = {}): Promise<T[]> {
    const docs = await this.docs.list({ ...query, kind });
    return docs.map((d) => d.payload as T);
  }

  async listStamped<T>(kind: Kind, query: Omit<DocumentQuery, 'kind'> = {}): Promise<Stamped<T>[]> {
    const docs = await this.docs.list({ ...query, kind });
    return docs.map(toStamped<T>);
  }

  remove(kind: Kind, id: string): Promise<boolean> {
    return this.docs.remove(kind, id);
  }
}

function toStamped<T>(doc: StoredDocument): Stamped<T> {
  return {
    payload: doc.payload as T,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    missionId: doc.missionId,
    runId: doc.runId,
    scope: doc.scope,
  };
}

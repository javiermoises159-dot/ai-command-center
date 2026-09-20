/**
 * Drizzle adapter for the document store (`madre_documents`).
 *
 * `put` is a single upsert, so two engines racing to write the same run state
 * cannot fail on a duplicate key; the later write wins and `createdAt` is kept.
 */

import type { DocumentQuery, DocumentStore, PutDocumentData, StoredDocument } from '@acc/domain';
import { madreDocuments, type Database } from '@acc/database';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';

type Row = typeof madreDocuments.$inferSelect;

function toDocument(row: Row): StoredDocument {
  return {
    kind: row.kind,
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    payload: row.payload,
  };
}

export class DrizzleDocumentStore implements DocumentStore {
  constructor(private readonly db: Database) {}

  async put(data: PutDocumentData): Promise<void> {
    await this.db
      .insert(madreDocuments)
      .values({
        kind: data.kind,
        id: data.id,
        missionId: data.missionId ?? null,
        runId: data.runId ?? null,
        scope: data.scope ?? null,
        payload: data.payload,
        createdAt: data.at,
        updatedAt: data.at,
      })
      .onConflictDoUpdate({
        target: [madreDocuments.kind, madreDocuments.id],
        set: {
          missionId: data.missionId ?? null,
          runId: data.runId ?? null,
          scope: data.scope ?? null,
          payload: data.payload,
          updatedAt: data.at,
        },
      });
  }

  async get(kind: string, id: string): Promise<StoredDocument | null> {
    const [row] = await this.db
      .select()
      .from(madreDocuments)
      .where(and(eq(madreDocuments.kind, kind), eq(madreDocuments.id, id)))
      .limit(1);
    return row ? toDocument(row) : null;
  }

  async list(query: DocumentQuery = {}): Promise<StoredDocument[]> {
    const conditions: SQL[] = [];
    if (query.kind !== undefined) {
      conditions.push(
        Array.isArray(query.kind)
          ? inArray(madreDocuments.kind, [...query.kind])
          : eq(madreDocuments.kind, query.kind as string),
      );
    }
    if (query.missionId !== undefined) conditions.push(eq(madreDocuments.missionId, query.missionId));
    if (query.runId !== undefined) conditions.push(eq(madreDocuments.runId, query.runId));
    if (query.scope !== undefined) conditions.push(eq(madreDocuments.scope, query.scope));

    const order = query.order === 'desc' ? desc : asc;
    const base = this.db
      .select()
      .from(madreDocuments)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(order(madreDocuments.createdAt), order(madreDocuments.id));

    const rows = query.limit !== undefined ? await base.limit(query.limit) : await base;
    return rows.map(toDocument);
  }

  async remove(kind: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(madreDocuments)
      .where(and(eq(madreDocuments.kind, kind), eq(madreDocuments.id, id)))
      .returning({ id: madreDocuments.id });
    return rows.length > 0;
  }
}

/**
 * Memory service.
 *
 * Memory holds what MADRE has learned about the user, their projects and past
 * missions. Its main job is to keep provenance honest:
 *
 *  - Text an agent generated is stored as a *result*, never as a *fact*, and is
 *    never marked verified by the agent itself.
 *  - `verified` is accepted only from the user, or from a tool/system entry that
 *    names a reference a reader can check.
 *  - Unverified confidence is capped, so a recall never presents a guess with
 *    the weight of a confirmed fact.
 *  - Temporary entries expire.
 */

import { newId } from '@acc/domain';

import { KINDS, type MadreStore } from '../store.ts';
import type { MemoryEntry, MemoryScope, MemoryType } from '../types.ts';
import { clamp, round, unique } from '../util.ts';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'user_context',
  'project_context',
  'mission_history',
  'fact',
  'decision',
  'preference',
  'result',
  'lesson',
  'external_source',
  'temporary',
];

export const UNVERIFIED_CONFIDENCE_CAP = 0.6;
export const TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000;

export interface RememberInput {
  type: MemoryType;
  scope?: MemoryScope;
  title: string;
  content: string;
  origin: MemoryEntry['source']['origin'];
  ref?: string | null;
  confidence?: number;
  /** A request: honoured only when the origin and reference allow it. */
  verified?: boolean;
  missionId?: string | null;
  runId?: string | null;
  tags?: string[];
  ttlMs?: number | null;
}

export interface RememberOutcome {
  entry: MemoryEntry;
  /** What was changed from the request, in words. Empty when stored as asked. */
  adjustments: string[];
}

export interface RecallQuery {
  query?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  missionId?: string;
  onlyVerified?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

export interface RecalledEntry {
  entry: MemoryEntry;
  score: number;
}

function tokens(text: string): string[] {
  return unique(
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

export class MemoryService {
  constructor(private readonly store: MadreStore) {}

  async remember(input: RememberInput): Promise<RememberOutcome> {
    const adjustments: string[] = [];
    const now = this.store.clock.now();

    let type = input.type;
    let verified = input.verified === true;
    const ref = input.ref ?? null;

    const canVerify =
      input.origin === 'user' || ((input.origin === 'tool' || input.origin === 'system') && ref !== null && ref.length > 0);
    if (verified && !canVerify) {
      verified = false;
      adjustments.push(
        `Guardado como no verificado: las entradas de origen «${input.origin}» necesitan una confirmación del usuario o una referencia comprobable para contar como verificadas.`,
      );
    }

    if (type === 'fact' && !verified) {
      type = 'result';
      adjustments.push('Guardado como resultado, no como hecho: un hecho necesita verificación.');
    }

    let confidence = clamp(input.confidence ?? (verified ? 0.9 : 0.5), 0, 1);
    if (!verified && confidence > UNVERIFIED_CONFIDENCE_CAP) {
      confidence = UNVERIFIED_CONFIDENCE_CAP;
      adjustments.push(`Confianza limitada a ${UNVERIFIED_CONFIDENCE_CAP} mientras no esté verificado.`);
    }

    const ttl = input.ttlMs !== undefined ? input.ttlMs : type === 'temporary' ? TEMPORARY_TTL_MS : null;

    const entry: MemoryEntry = {
      id: newId(),
      type,
      scope: input.scope ?? (input.missionId != null ? 'mission' : 'project'),
      title: input.title.trim().slice(0, 200),
      content: input.content.trim(),
      source: { origin: input.origin, ref },
      confidence: round(confidence, 2),
      verified,
      missionId: input.missionId ?? null,
      runId: input.runId ?? null,
      tags: unique((input.tags ?? []).map((t) => t.toLowerCase())),
      createdAt: now.toISOString(),
      expiresAt: ttl === null ? null : new Date(now.getTime() + ttl).toISOString(),
    };

    await this.store.put(KINDS.memory, entry.id, entry, { missionId: entry.missionId, runId: entry.runId, scope: entry.scope });
    return { entry, adjustments };
  }

  get(id: string): Promise<MemoryEntry | null> {
    return this.store.get<MemoryEntry>(KINDS.memory, id);
  }

  async forget(id: string): Promise<boolean> {
    return this.store.remove(KINDS.memory, id);
  }

  async list(query: Omit<RecallQuery, 'query'> = {}): Promise<MemoryEntry[]> {
    const docs = await this.store.list<MemoryEntry>(KINDS.memory, {
      ...(query.missionId !== undefined ? { missionId: query.missionId } : {}),
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
      order: 'desc',
      limit: 1000,
    });
    const now = this.store.clock.now().getTime();
    return docs
      .filter((e) => query.type === undefined || e.type === query.type)
      .filter((e) => query.onlyVerified !== true || e.verified)
      .filter((e) => query.includeExpired === true || e.expiresAt === null || Date.parse(e.expiresAt) > now)
      .slice(0, query.limit ?? 1000);
  }

  /** Keyword recall ranked by relevance, confidence and recency. */
  async recall(query: RecallQuery = {}): Promise<RecalledEntry[]> {
    const entries = await this.list(query);
    const wanted = tokens(query.query ?? '');
    const now = this.store.clock.now().getTime();

    const scored: RecalledEntry[] = [];
    for (const entry of entries) {
      let relevance = 1;
      if (wanted.length > 0) {
        const haystack = new Set(tokens(`${entry.title} ${entry.content} ${entry.tags.join(' ')}`));
        const titleTokens = new Set(tokens(entry.title));
        let hits = 0;
        for (const t of wanted) {
          if (haystack.has(t)) hits += titleTokens.has(t) ? 2 : 1;
        }
        if (hits === 0) continue;
        relevance = hits / (wanted.length * 2);
      }
      const ageDays = Math.max(0, (now - Date.parse(entry.createdAt)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 30);
      const score = round(relevance * (0.5 + 0.5 * entry.confidence) * (0.7 + 0.3 * recency), 4);
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit ?? 10);
  }

  /** Delete expired entries. Returns how many were removed. */
  async expire(): Promise<number> {
    const all = await this.store.list<MemoryEntry>(KINDS.memory, { limit: 5000 });
    const now = this.store.clock.now().getTime();
    let removed = 0;
    for (const entry of all) {
      if (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now) {
        if (await this.store.remove(KINDS.memory, entry.id)) removed += 1;
      }
    }
    return removed;
  }

  async stats(): Promise<{ total: number; verified: number; lessons: number; byType: Record<MemoryType, number> }> {
    const entries = await this.list();
    const byType = Object.fromEntries(MEMORY_TYPES.map((t) => [t, 0])) as Record<MemoryType, number>;
    for (const e of entries) byType[e.type] += 1;
    return {
      total: entries.length,
      verified: entries.filter((e) => e.verified).length,
      lessons: byType.lesson,
      byType,
    };
  }

  /** A lesson learned from a run (a failure, a revision). Always unverified, always system-origin. */
  recordLesson(input: { title: string; content: string; missionId?: string | null; runId?: string | null; tags?: string[] }) {
    return this.remember({
      type: 'lesson',
      scope: input.missionId != null ? 'mission' : 'project',
      title: input.title,
      content: input.content,
      origin: 'system',
      confidence: 0.5,
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      tags: ['lesson', ...(input.tags ?? [])],
    });
  }
}

/**
 * Drizzle schema. Mirrors `migrations/0000_init.sql` exactly.
 *
 * The SQL file is the source of truth for what runs against the database; this
 * file is the typed view of it. `drizzle-kit generate` produces new migrations
 * from changes here — always review the generated SQL before committing it.
 */

import { relations } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const missions = pgTable(
  'missions',
  {
    id: uuid('id').primaryKey(),
    prompt: text('prompt').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('pending'),
    finalResult: text('final_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('missions_created_at_idx').on(table.createdAt.desc()),
    index('missions_status_idx').on(table.status),
    check('missions_status_check', sql`${table.status} IN ('pending', 'running', 'completed', 'failed')`),
  ],
);

export const missionRuns = pgTable(
  'mission_runs',
  {
    id: uuid('id').primaryKey(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull().default('pending'),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    finalResult: text('final_result'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('mission_runs_mission_idx').on(table.missionId, table.attempt.desc()),
    unique('mission_runs_mission_attempt_key').on(table.missionId, table.attempt),
    // Target of the composite FK from mission_agents.
    unique('mission_runs_id_mission_key').on(table.id, table.missionId),
    check('mission_runs_status_check', sql`${table.status} IN ('pending', 'running', 'completed', 'failed')`),
    check('mission_runs_attempt_positive', sql`${table.attempt} > 0`),
  ],
);

export const missionAgents = pgTable(
  'mission_agents',
  {
    id: uuid('id').primaryKey(),
    missionId: uuid('mission_id').notNull(),
    runId: uuid('run_id').notNull(),
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull(),
    status: text('status').notNull().default('pending'),
    task: text('task').notNull(),
    result: text('result'),
    error: text('error'),
    usageProvider: text('usage_provider'),
    usageModel: text('usage_model'),
    usageRequestId: text('usage_request_id'),
    usagePromptTokens: integer('usage_prompt_tokens'),
    usageCompletionTokens: integer('usage_completion_tokens'),
    usageTotalTokens: integer('usage_total_tokens'),
    usageLatencyMs: integer('usage_latency_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('mission_agents_run_idx').on(table.runId, table.orderIndex),
    index('mission_agents_mission_idx').on(table.missionId),
    unique('mission_agents_run_order_key').on(table.runId, table.orderIndex),
    check(
      'mission_agents_status_check',
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'skipped')`,
    ),
  ],
);

export const missionsRelations = relations(missions, ({ many }) => ({
  runs: many(missionRuns),
  agents: many(missionAgents),
}));

export const missionRunsRelations = relations(missionRuns, ({ one, many }) => ({
  mission: one(missions, { fields: [missionRuns.missionId], references: [missions.id] }),
  agents: many(missionAgents),
}));

export const missionAgentsRelations = relations(missionAgents, ({ one }) => ({
  run: one(missionRuns, { fields: [missionAgents.runId], references: [missionRuns.id] }),
  mission: one(missions, { fields: [missionAgents.missionId], references: [missions.id] }),
}));

export type MissionRow = typeof missions.$inferSelect;
export type MissionRunRow = typeof missionRuns.$inferSelect;
export type MissionAgentRow = typeof missionAgents.$inferSelect;

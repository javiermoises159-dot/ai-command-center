/**
 * Example missions used by the end-to-end tests and the UI's "try an example".
 * Each carries what MADRE is expected to conclude, so a regression in the
 * compiler or the planner shows up as a failing expectation, not a vague change.
 */

import type { MissionKind } from '../types.ts';

export interface ExampleMission {
  id: string;
  title: string;
  prompt: string;
  expect: {
    kind: MissionKind;
    language: 'es' | 'en' | 'it';
    /** Capabilities that must appear among the tasks. */
    capabilities: string[];
    /** Capabilities that must be reported as gaps (none of them are provided in this build). */
    gaps: string[];
    /** Places / amounts / timeframes quoted from the text. */
    places?: string[];
    amounts?: number[];
    timeframes?: string[];
    /** Whether the plan must include a step that waits for the user. */
    needsInput?: boolean;
  };
}

export const EXAMPLE_MISSIONS: readonly ExampleMission[] = [
  {
    id: 'cookies-italy',
    title: 'Tienda online de cookies en Italia',
    prompt: 'Quiero lanzar una tienda online de cookies en Italia.',
    expect: {
      kind: 'launch_business',
      language: 'es',
      capabilities: ['strategy.positioning', 'research.market', 'finance.unit_economics', 'marketing.go_to_market', 'engineering.architecture'],
      gaps: ['research.web', 'legal.compliance'],
      places: ['Italia'],
    },
  },
  {
    id: 'market-and-validate',
    title: 'Investigar un mercado y decidir qué validar',
    prompt: 'Research the market for specialty coffee subscriptions in Germany and tell me what I should validate first.',
    expect: {
      kind: 'market_research',
      language: 'en',
      capabilities: ['research.market', 'research.competitors', 'strategy.assumptions'],
      gaps: ['research.web'],
      places: ['Germany'],
    },
  },
  {
    id: 'idea-to-experiment',
    title: 'Convertir una idea de negocio en un experimento de validación',
    prompt: 'Tengo una idea de negocio: cursos de cocina para jubilados. Quiero un experimento para validarla en 2 semanas con 300 euros.',
    expect: {
      kind: 'validation_experiment',
      language: 'es',
      capabilities: ['strategy.assumptions', 'finance.experiment_cost', 'marketing.messaging'],
      gaps: ['research.web'],
      amounts: [300],
      timeframes: ['2 semanas'],
    },
  },
  {
    id: 'content-campaign',
    title: 'Campaña de contenidos para una marca',
    prompt: 'Plan a content campaign for Nordic Oat, a new oat-drink brand, across Instagram and TikTok.',
    expect: {
      kind: 'content_campaign',
      language: 'en',
      capabilities: ['research.audience', 'marketing.messaging', 'marketing.campaign', 'design.visual_brief'],
      gaps: ['content.script', 'research.web'],
    },
  },
  {
    id: 'document-priorities',
    title: 'Convertir documentos en acciones prioritarias',
    prompt: 'Analiza estos documentos y dime las acciones prioritarias.',
    expect: {
      kind: 'document_analysis',
      language: 'es',
      capabilities: ['research.documents', 'strategy.prioritization'],
      gaps: [],
      needsInput: true,
    },
  },
];

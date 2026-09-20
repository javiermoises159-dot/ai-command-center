/**
 * Input validation for tool calls.
 *
 * A tool declares its input in `ToolSpec.inputSchema`; this module is the code
 * that actually holds callers to it. Nothing else in MADRE checks tool input,
 * so a tool must never be executed without passing through `validateToolInput`
 * first.
 *
 * The rules are deliberately small and explicit — required fields, declared
 * types, `enum` values and the size ceiling from `ToolSpec.limits`. Fields the
 * schema does not declare are allowed unless the schema says
 * `additionalProperties: false`, in which case each one is an error: the
 * catalog's tools are all strict, because a misspelt field that is silently
 * ignored is a call that runs with the wrong arguments. Every message is
 * written for the person reading the run, in Spanish, and says which field
 * failed and why.
 */

import type { FieldSpec, ToolSchema, ToolSpec } from '../types.ts';

export interface ToolValidation {
  ok: boolean;
  /** One sentence per problem, in the order the schema declares the fields. */
  errors: string[];
}

const TYPE_LABEL: Record<FieldSpec['type'], string> = {
  string: 'texto',
  number: 'número',
  boolean: 'booleano',
  object: 'objeto',
  array: 'lista',
};

/** How to name whatever the caller actually sent, in a message. */
function describe(value: unknown): string {
  if (value === null) return 'nulo';
  if (value === undefined) return 'nada';
  if (Array.isArray(value)) return 'una lista';
  switch (typeof value) {
    case 'string':
      return 'texto';
    case 'number':
      return Number.isFinite(value) ? 'un número' : 'un número no finito';
    case 'boolean':
      return 'un booleano';
    case 'object':
      return 'un objeto';
    default:
      return typeof value;
  }
}

function matchesType(value: unknown, type: FieldSpec['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/** Serialised size of the input, or null when it cannot be serialised at all. */
export function inputByteSize(input: unknown): number | null {
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return null;
    return Buffer.byteLength(json, 'utf8');
  } catch {
    return null;
  }
}

/** Check a value against one field of a schema. Returns the problems found. */
function validateField(name: string, spec: FieldSpec, present: boolean, value: unknown): string[] {
  const label = TYPE_LABEL[spec.type];
  if (!present || value === undefined || value === null) {
    if (spec.required === true) return [`Falta el campo obligatorio «${name}» (${label}).`];
    return [];
  }
  if (!matchesType(value, spec.type)) {
    return [`El campo «${name}» debe ser ${spec.type === 'array' ? 'una lista' : spec.type === 'object' ? 'un objeto' : `un ${label}`}; se recibió ${describe(value)}.`];
  }
  if (spec.enum !== undefined && spec.enum.length > 0) {
    const allowed = spec.enum;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return [`El campo «${name}» solo admite estos valores: ${allowed.join(', ')}; se recibió «${String(value)}».`];
    }
  }
  return [];
}

/** Validate an input object against a schema, without any size ceiling. */
export function validateAgainstSchema(schema: ToolSchema, input: unknown): ToolValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [`La entrada debe ser un objeto con los campos de la herramienta; se recibió ${describe(input)}.`] };
  }
  const record = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    errors.push(...validateField(name, field, name in record, record[name]));
  }
  if (schema.additionalProperties === false) {
    const declared = Object.keys(schema.fields);
    for (const name of Object.keys(record)) {
      if (name in schema.fields) continue;
      errors.push(
        declared.length > 0
          ? `El campo «${name}» no existe en esta herramienta; solo admite: ${declared.join(', ')}.`
          : `El campo «${name}» no existe: esta herramienta no admite ningún campo.`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the input of a call against the tool's own contract: its schema and
 * its `limits.maxInputBytes`. This is the check the executor runs; a failed
 * validation must turn into a failed `ToolResult`, never into an execution.
 */
export function validateToolInput(spec: ToolSpec, input: unknown): ToolValidation {
  const errors: string[] = [];
  const size = inputByteSize(input);
  if (size === null) {
    errors.push('La entrada no se puede convertir a JSON, así que no se puede validar ni enviar a la herramienta.');
  } else if (spec.limits.maxInputBytes !== null && size > spec.limits.maxInputBytes) {
    errors.push(`La entrada ocupa ${size} bytes y «${spec.name}» admite como máximo ${spec.limits.maxInputBytes}.`);
  }
  errors.push(...validateAgainstSchema(spec.inputSchema, input).errors);
  return { ok: errors.length === 0, errors };
}

/** The validation problems as one sentence, for a `ToolResult.error`. */
export function formatValidationErrors(spec: ToolSpec, errors: readonly string[]): string {
  return `Entrada no válida para «${spec.name}» (${spec.id}): ${errors.join(' ')}`;
}

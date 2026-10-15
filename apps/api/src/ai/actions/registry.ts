import { createHash } from 'node:crypto';
import type { AiDataClass, ModuleFeature, Permission, Principal } from '@integr8/core';
import type { TenantTransaction } from '@integr8/db';
import type { z } from 'zod';
import type { RequestContext } from '../../http/routes.js';

/**
 * Actions the assistant may prepare and a member may confirm (docs/ai §9;
 * ADR-0001 D4).
 *
 * An action has two halves that never run in the same request. `prepare`
 * turns what the model asked for into a frozen, validated payload and a
 * preview a person can read, inside a proposal row with a short life.
 * `execute` runs only from the confirm route, from the same member, after
 * the gates have been checked again, through the same domain code the
 * screens use, with the member as the audit actor. The model is never
 * offered anything that writes.
 */

export interface ActionPrepareContext {
  principal: Principal;
  tx: TenantTransaction;
  features: Readonly<Record<string, boolean>>;
  locale: 'en' | 'ar';
  now: Date;
}

export interface ActionExecuteContext {
  context: RequestContext;
  tx: TenantTransaction;
  features: Readonly<Record<string, boolean>>;
  /** The proposal's id, carried into the audit entry as provenance. */
  proposalId: string;
}

/** What a person is shown before confirming: field by field, in their language. */
export interface ActionPreview {
  /** One line: what will happen. */
  title: string;
  /** The fields, label and value, for the confirmation card. */
  fields: { label: string; value: string }[];
  /** Anything they should know before saying yes. */
  warnings: string[];
}

export interface ActionResult {
  resourceType: string;
  resourceId: string;
  /** One line: what happened, with the reference. */
  summary: string;
  /** The app's route key and id, for a link to the record. */
  appRoute: string;
}

export interface AiAction<Input, Payload> {
  key: string;
  description: string;
  permission: Permission | readonly Permission[];
  feature?: ModuleFeature;
  dataClass: AiDataClass;
  inputSchema: z.ZodType<Input>;
  /** The frozen payload's schema, checked again at execution. */
  payloadSchema: z.ZodType<Payload>;
  payloadSchemaVersion: number;
  /** Resolves names to ids, checks what the screens check, and says what will happen. */
  prepare(
    context: ActionPrepareContext,
    input: Input,
  ): Promise<{
    payload: Payload;
    preview: ActionPreview;
    resourceVersions: Record<string, unknown>;
  }>;
  /** Runs the action through the domain code, inside the tenant transaction given. */
  execute(context: ActionExecuteContext, payload: Payload): Promise<ActionResult>;
  /** Re-reads the records the payload names and says whether they still match. */
  verify(
    context: ActionPrepareContext,
    payload: Payload,
    resourceVersions: Record<string, unknown>,
  ): Promise<boolean>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAiAction = AiAction<any, any>;

export function defineAction<Input, Payload>(action: AiAction<Input, Payload>): AnyAiAction {
  return action;
}

/** A stable digest of a payload: what confirmation compares against. */
export function payloadDigest(toolKey: string, payload: unknown): string {
  return createHash('sha256').update(toolKey).update('\n').update(canonical(payload)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

export function previewLabel(locale: 'en' | 'ar', en: string, ar: string): string {
  return locale === 'ar' ? ar : en;
}

import { DEFAULT_PIPELINE_STAGES, type StageOutcome } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CrmPipelineStagesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * A company's sales pipelines and their stages (CRM/ERP plan, phase C3).
 *
 * Every company has a default pipeline, made the first time its CRM asks for
 * one rather than by the migration, so a company created tomorrow gets it the
 * same way as one created last year. Making it twice at once leaves one: the
 * unique index on the default decides, and the loser reads the winner's.
 */

export interface PipelineStage {
  id: string;
  pipelineId: string;
  /** Stable; screens translate the built-in ones (`crm.stage.<key>`). */
  key: string;
  label: string;
  position: number;
  /** The usual chance of winning from here, in basis points. */
  probabilityBp: number;
  outcome: StageOutcome;
  archivedAt: Date | null;
}

export interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  /** In order, archived ones included (history may point at them). */
  stages: PipelineStage[];
}

export class CrmPipelinesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The company's default pipeline, made with the standard stages if it has none yet. */
  async ensureDefault(): Promise<Pipeline> {
    const { rows } = await sql<{ id: string }>`
      insert into crm_pipelines (tenant_id, name, is_default)
      values (${this.tenantId}, 'Sales', true)
      on conflict (tenant_id) where is_default do nothing
      returning id
    `.execute(this.db);
    const created = rows[0];
    if (created !== undefined) {
      await this.db
        .insertInto('crm_pipeline_stages')
        .values(
          DEFAULT_PIPELINE_STAGES.map((stage, index) => ({
            tenant_id: this.tenantId,
            pipeline_id: created.id,
            key: stage.key,
            label: stage.label,
            position: index + 1,
            probability_bp: stage.probabilityBp,
            outcome: stage.outcome,
          })),
        )
        .execute();
    }
    const pipeline = await this.db
      .selectFrom('crm_pipelines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    return {
      id: pipeline.id,
      name: pipeline.name,
      isDefault: true,
      stages: await this.stages(pipeline.id),
    };
  }

  /** Every current pipeline, the default first. Makes the default if there is none. */
  async list(): Promise<Pipeline[]> {
    await this.ensureDefault();
    const pipelines = await this.db
      .selectFrom('crm_pipelines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('archived_at', 'is', null)
      .orderBy('is_default', 'desc')
      .orderBy(sql`lower(name)`)
      .execute();
    const stages = await this.db
      .selectFrom('crm_pipeline_stages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where(
        'pipeline_id',
        'in',
        pipelines.map((pipeline) => pipeline.id),
      )
      .orderBy('position')
      .execute();
    return pipelines.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.is_default,
      stages: stages.filter((stage) => stage.pipeline_id === pipeline.id).map(toStage),
    }));
  }

  async stages(pipelineId: string): Promise<PipelineStage[]> {
    return (
      await this.db
        .selectFrom('crm_pipeline_stages')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('pipeline_id', '=', pipelineId)
        .orderBy('position')
        .execute()
    ).map(toStage);
  }

  async findStage(stageId: string): Promise<PipelineStage | undefined> {
    const row = await this.db
      .selectFrom('crm_pipeline_stages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', stageId)
      .executeTakeFirst();
    return row === undefined ? undefined : toStage(row);
  }

  async findStages(stageIds: readonly string[]): Promise<PipelineStage[]> {
    if (stageIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('crm_pipeline_stages')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(stageIds)])
        .execute()
    ).map(toStage);
  }

  // -------------------------------------------------------------------------
  // Editing (eighth round; ADR-0012). Callers check what may change first, so
  // a refusal can be said in words; the database's constraints insist.
  // -------------------------------------------------------------------------

  async find(pipelineId: string): Promise<Pipeline | undefined> {
    const row = await this.db
      .selectFrom('crm_pipelines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', pipelineId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          isDefault: row.is_default,
          stages: await this.stages(row.id),
        };
  }

  /** The pipeline's row locked, so two edits of its stages apply one after the other. */
  async lock(pipelineId: string): Promise<Pipeline | undefined> {
    await this.db
      .selectFrom('crm_pipelines')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', pipelineId)
      .forUpdate()
      .executeTakeFirst();
    return this.find(pipelineId);
  }

  async #nameTaken(name: string, exceptId?: string): Promise<boolean> {
    let select = this.db
      .selectFrom('crm_pipelines')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where(sql<boolean>`lower(name) = lower(${name.trim()})`);
    if (exceptId !== undefined) {
      select = select.where('id', '<>', exceptId);
    }
    return (await select.executeTakeFirst()) !== undefined;
  }

  /** A new pipeline with the standard stages, renamed as the company likes later. */
  async create(name: string): Promise<Pipeline | 'name_taken'> {
    if (await this.#nameTaken(name)) {
      return 'name_taken';
    }
    const row = await this.db
      .insertInto('crm_pipelines')
      .values({ tenant_id: this.tenantId, name: name.trim(), is_default: false })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto('crm_pipeline_stages')
      .values(
        DEFAULT_PIPELINE_STAGES.map((stage, index) => ({
          tenant_id: this.tenantId,
          pipeline_id: row.id,
          key: stage.key,
          label: stage.label,
          position: index + 1,
          probability_bp: stage.probabilityBp,
          outcome: stage.outcome,
        })),
      )
      .execute();
    return (await this.find(row.id))!;
  }

  async rename(pipelineId: string, name: string): Promise<'name_taken' | undefined> {
    if (await this.#nameTaken(name, pipelineId)) {
      return 'name_taken';
    }
    await this.db
      .updateTable('crm_pipelines')
      .set({ name: name.trim() })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', pipelineId)
      .execute();
    return undefined;
  }

  /** Makes this pipeline the one new opportunities start in. */
  async makeDefault(pipelineId: string): Promise<void> {
    await this.db
      .updateTable('crm_pipelines')
      .set({ is_default: false })
      .where('tenant_id', '=', this.tenantId)
      .where('is_default', '=', true)
      .execute();
    await this.db
      .updateTable('crm_pipelines')
      .set({ is_default: true })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', pipelineId)
      .execute();
  }

  async archive(pipelineId: string): Promise<void> {
    await this.db
      .updateTable('crm_pipelines')
      .set({ archived_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', pipelineId)
      .where('is_default', '=', false)
      .execute();
  }

  /** How many opportunities stand in each stage, by status. */
  async occupancy(pipelineId: string): Promise<Map<string, { open: number; closed: number }>> {
    const rows = await this.db
      .selectFrom('crm_opportunities')
      .select([
        'stage_id',
        sql<number>`count(*) filter (where status = 'open')::int`.as('open'),
        sql<number>`count(*) filter (where status <> 'open')::int`.as('closed'),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('pipeline_id', '=', pipelineId)
      .groupBy('stage_id')
      .execute();
    return new Map(rows.map((row) => [row.stage_id, { open: row.open, closed: row.closed }]));
  }

  /** Whether any opportunity is in the stage now or ever passed through it. */
  async stageUsed(stageId: string): Promise<boolean> {
    const row = await this.db
      .selectNoFrom([
        sql<boolean>`exists (select 1 from crm_opportunities o where o.tenant_id = ${this.tenantId}::uuid and o.stage_id = ${stageId}::uuid)
          or exists (select 1 from crm_opportunity_events e where e.tenant_id = ${this.tenantId}::uuid and (e.from_stage_id = ${stageId}::uuid or e.to_stage_id = ${stageId}::uuid))`.as(
          'used',
        ),
      ])
      .executeTakeFirstOrThrow();
    return row.used;
  }

  /**
   * A new stage at the end of the pipeline's current stages. Its key comes
   * from its label and is never one the pipeline has used before.
   */
  async addStage(
    pipelineId: string,
    input: { label: string; probabilityBp: number; outcome: StageOutcome },
  ): Promise<PipelineStage> {
    const stages = await this.stages(pipelineId);
    const keys = new Set(stages.map((stage) => stage.key));
    const base =
      input.label
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/gu, '_')
        .replace(/^_+|_+$/gu, '')
        .replace(/^[^a-z]+/u, '')
        .slice(0, 30) || 'stage';
    let key = base;
    for (let suffix = 2; keys.has(key); suffix += 1) {
      key = `${base}_${String(suffix)}`;
    }
    const position = Math.max(0, ...stages.map((stage) => stage.position)) + 1;
    const row = await this.db
      .insertInto('crm_pipeline_stages')
      .values({
        tenant_id: this.tenantId,
        pipeline_id: pipelineId,
        key,
        label: input.label.trim(),
        position,
        probability_bp: input.probabilityBp,
        outcome: input.outcome,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toStage(row);
  }

  async updateStage(
    stageId: string,
    input: {
      label?: string | undefined;
      probabilityBp?: number | undefined;
      outcome?: StageOutcome | undefined;
    },
  ): Promise<PipelineStage | undefined> {
    const row = await this.db
      .updateTable('crm_pipeline_stages')
      .set({
        ...(input.label === undefined ? {} : { label: input.label.trim() }),
        ...(input.probabilityBp === undefined ? {} : { probability_bp: input.probabilityBp }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', stageId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toStage(row);
  }

  /**
   * Puts the current stages in the given order; archived ones go after them.
   * Positions are unique, so everything moves out of the way first.
   */
  async reorder(pipelineId: string, stageIds: readonly string[]): Promise<void> {
    await this.db
      .updateTable('crm_pipeline_stages')
      .set({ position: sql<number>`position + 100000` })
      .where('tenant_id', '=', this.tenantId)
      .where('pipeline_id', '=', pipelineId)
      .execute();
    const stages = await this.stages(pipelineId);
    const order = [
      ...stageIds,
      ...stages
        .filter((stage) => !stageIds.includes(stage.id))
        .sort((a, b) => a.position - b.position)
        .map((stage) => stage.id),
    ];
    for (const [index, id] of order.entries()) {
      await this.db
        .updateTable('crm_pipeline_stages')
        .set({ position: index + 1 })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .execute();
    }
  }

  async archiveStage(stageId: string): Promise<void> {
    await this.db
      .updateTable('crm_pipeline_stages')
      .set({ archived_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', stageId)
      .execute();
  }

  /** The open opportunities in a stage, to move before archiving it. */
  async openInStage(stageId: string): Promise<{ id: string; version: number }[]> {
    return this.db
      .selectFrom('crm_opportunities')
      .select(['id', 'version'])
      .where('tenant_id', '=', this.tenantId)
      .where('stage_id', '=', stageId)
      .where('status', '=', 'open')
      .orderBy('id')
      .forUpdate()
      .execute();
  }
}

function toStage(row: Selectable<CrmPipelineStagesTable>): PipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    key: row.key,
    label: row.label,
    position: row.position,
    probabilityBp: row.probability_bp,
    outcome: row.outcome,
    archivedAt: row.archived_at,
  };
}

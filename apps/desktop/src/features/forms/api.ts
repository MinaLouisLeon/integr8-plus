import type { paths } from '@integr8/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { session } from '~/lib/session';

/**
 * The form builder's calls, typed from the generated contract.
 *
 * Every failure arrives as a thrown `ApiRequestError` (the client's middleware
 * converts it), so `data` is always present on success and the `!` below is
 * an assertion about the contract, not a guess.
 */

type Json<
  P extends keyof paths,
  M extends 'get' | 'post' | 'put' | 'patch',
  S extends number,
> = paths[P][M] extends { responses: Record<S, { content: { 'application/json': infer T } }> }
  ? T
  : never;

export type Me = Json<'/v1/me', 'get', 200>;
export type FormList = Json<'/v1/forms', 'get', 200>;
export type FormListItem = FormList['items'][number];
export type FormDetail = Json<'/v1/forms/{formId}', 'get', 200>;
export type FormVersion = NonNullable<FormDetail['live']>;
export type FormSettings = Json<'/v1/forms/{formId}', 'patch', 200>;
export type DraftCheck = Json<'/v1/forms/{formId}/draft/check', 'post', 200>;
export type VersionSummary = Json<'/v1/forms/{formId}/draft/publish', 'post', 200>;
export type TestSubmission = Json<'/v1/forms/{formId}/draft/test-submission', 'post', 200>;
export type TemplateList = Json<'/v1/form-templates', 'get', 200>;
export type TemplateSummary = TemplateList['items'][number];
export type Template = Json<'/v1/form-templates/{key}', 'get', 200>;
export type Role = FormSettings['fillRoles'][number];

const client = () => session().client;

export const formKeys = {
  me: ['me'] as const,
  list: ['forms'] as const,
  detail: (formId: string) => ['forms', formId] as const,
  versions: (formId: string) => ['forms', formId, 'versions'] as const,
  version: (formId: string, versionId: string) => ['forms', formId, 'versions', versionId] as const,
  check: (formId: string) => ['forms', formId, 'check'] as const,
  templates: ['form-templates'] as const,
  template: (key: string) => ['form-templates', key] as const,
};

export function useMe() {
  return useQuery({
    queryKey: formKeys.me,
    queryFn: async () => (await client().GET('/v1/me')).data!,
  });
}

/** Whether this person may build and publish forms. A convenience for hiding buttons; the server decides. */
export function canManageForms(me: Me | undefined): boolean {
  return me?.permissions.includes('form.manage') ?? false;
}

export function useForms() {
  return useQuery({
    queryKey: formKeys.list,
    queryFn: async () => (await client().GET('/v1/forms')).data!.items,
  });
}

export function useForm(formId: string) {
  return useQuery({
    queryKey: formKeys.detail(formId),
    queryFn: async () =>
      (await client().GET('/v1/forms/{formId}', { params: { path: { formId } } })).data!,
    // The builder owns the draft once it is open; a background refetch must not
    // replace what somebody is in the middle of editing.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useVersions(formId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: formKeys.versions(formId),
    queryFn: async () =>
      (await client().GET('/v1/forms/{formId}/versions', { params: { path: { formId } } })).data!
        .items,
  });
}

export function useVersion(formId: string, versionId: string) {
  return useQuery({
    queryKey: formKeys.version(formId, versionId),
    queryFn: async () =>
      (
        await client().GET('/v1/forms/{formId}/versions/{versionId}', {
          params: { path: { formId, versionId } },
        })
      ).data!,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: formKeys.templates,
    queryFn: async () => (await client().GET('/v1/form-templates')).data!.items,
    enabled,
  });
}

export function useTemplate(key: string | undefined) {
  return useQuery({
    queryKey: formKeys.template(key ?? ''),
    queryFn: async () =>
      (await client().GET('/v1/form-templates/{key}', { params: { path: { key: key! } } })).data!,
    enabled: key !== undefined,
  });
}

const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });

export function useCreateForm() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; locale: string }) =>
      (await client().POST('/v1/forms', { params: { header: idempotency() }, body: input })).data!,
    onSuccess: () => queries.invalidateQueries({ queryKey: formKeys.list, exact: true }),
  });
}

export function useCopyForm() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string; title: string }) =>
      (
        await client().POST('/v1/forms/{formId}/clone', {
          params: { path: { formId: input.formId }, header: idempotency() },
          body: { title: input.title },
        })
      ).data!,
    onSuccess: () => queries.invalidateQueries({ queryKey: formKeys.list, exact: true }),
  });
}

export function useCopyTemplate() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) =>
      (
        await client().POST('/v1/form-templates/{key}/clone', {
          params: { path: { key }, header: idempotency() },
          body: {},
        })
      ).data!,
    onSuccess: () => queries.invalidateQueries({ queryKey: formKeys.list, exact: true }),
  });
}

export async function saveDraft(
  formId: string,
  definition: Record<string, unknown>,
  expectedRevision: number | null,
): Promise<FormVersion> {
  return (
    await client().PUT('/v1/forms/{formId}/draft', {
      params: { path: { formId } },
      body: { definition: definition as { schemaVersion: number }, expectedRevision },
    })
  ).data!;
}

export async function checkDraft(formId: string): Promise<DraftCheck> {
  return (await client().POST('/v1/forms/{formId}/draft/check', { params: { path: { formId } } }))
    .data!;
}

export async function publishDraft(
  formId: string,
  body: { expectedRevision: number; changeNote?: string; acknowledgeBreakingChanges: boolean },
): Promise<VersionSummary> {
  return (
    await client().POST('/v1/forms/{formId}/draft/publish', { params: { path: { formId } }, body })
  ).data!;
}

export async function testSubmission(
  formId: string,
  answers: Record<string, unknown>,
  today: string,
): Promise<TestSubmission> {
  return (
    await client().POST('/v1/forms/{formId}/draft/test-submission', {
      params: { path: { formId } },
      body: { answers, today },
    })
  ).data!;
}

/** The company's job types, for the setting that says which ones require a form. */
export function useJobTypes() {
  return useQuery({
    queryKey: ['job-types', false],
    queryFn: async () => (await client().GET('/v1/job-types')).data!.items,
    // Which types require a form is changed from the job types screen too; the
    // settings panel reads it from here, so it must not show an old answer.
    refetchOnMount: 'always',
  });
}

export function useUpdateSettings(formId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      title?: string;
      fillRoles?: Role[];
      signatureRequired?: boolean;
      requiredByJobTypeIds?: string[];
    }) =>
      (await client().PATCH('/v1/forms/{formId}', { params: { path: { formId } }, body })).data!,
    onSuccess: (form) => {
      queries.setQueryData<FormDetail>(formKeys.detail(formId), (current) =>
        current === undefined ? current : { ...current, form },
      );
      return Promise.all([
        queries.invalidateQueries({ queryKey: formKeys.list, exact: true }),
        // The requirement is stored with the job types.
        queries.invalidateQueries({ queryKey: ['job-types'] }),
      ]);
    },
  });
}

import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, Dialog, Failure, InlineError, Loading } from '../ui.js';

/**
 * What a job type's jobs, or one job, need its people to hold (P26): shown as
 * a short list, and chosen from the company's qualifications in a dialog.
 */

export interface Requirement {
  qualificationTypeId: string;
  name: string;
  /** An archived qualification may stay on the list, to be taken off; never added. */
  archived?: boolean;
}

/** The requirements, by name, or a line saying there are none. */
export function RequirementList({
  requirements,
  emptyText,
}: {
  requirements: readonly Requirement[];
  emptyText: string;
}) {
  const { t } = useTranslation();
  if (requirements.length === 0) {
    return <p className="text-sm text-content-muted">{emptyText}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {requirements.map((requirement) => (
        <li
          key={requirement.qualificationTypeId}
          dir="auto"
          className="rounded-full border border-border-subtle bg-surface-muted px-2.5 py-0.5 text-xs text-content"
        >
          {requirement.name}
          {requirement.archived === true ? (
            <span className="text-content-muted">
              {' '}
              ({t('operations.qualifications.archivedBadge')})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Choose the requirements from the company's list; saving replaces the whole list. */
export function RequirementsDialog({
  title,
  intro,
  current,
  onSave,
  onClose,
  onSaved,
}: {
  title: string;
  intro: string;
  current: readonly Requirement[];
  onSave: (qualificationTypeIds: string[]) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [chosen, setChosen] = useState<string[]>(
    current.map((requirement) => requirement.qualificationTypeId),
  );
  const types = useQuery({
    queryKey: keys.qualificationTypes(false),
    queryFn: async () => (await client.GET('/v1/qualification-types')).data!,
  });
  const save = useMutation({
    mutationFn: async () => onSave(chosen),
    onSuccess: onSaved,
  });

  // Archived ones already required stay listed, so they can be taken off.
  const archivedHere = current.filter(
    (requirement) =>
      requirement.archived === true ||
      (types.data !== undefined &&
        !types.data.items.some((type) => type.id === requirement.qualificationTypeId)),
  );
  const toggle = (id: string, on: boolean) =>
    setChosen((list) => (on ? [...list, id] : list.filter((entry) => entry !== id)));

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={save.isPending || types.data === undefined}
            aria-busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="text-content-muted">{intro}</p>
      {types.isError ? (
        <InlineError onRetry={() => void types.refetch()} />
      ) : types.data === undefined ? (
        <Loading />
      ) : types.data.items.length === 0 && archivedHere.length === 0 ? (
        <p className="text-content-muted">{t('operations.qualifications.requirements.noTypes')}</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{title}</legend>
          {types.data.items.map((type) => (
            <label
              key={type.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-muted"
            >
              <input
                type="checkbox"
                checked={chosen.includes(type.id)}
                onChange={(event) => toggle(type.id, event.target.checked)}
              />
              <span dir="auto" className="text-content">
                {type.name}
              </span>
              <span className="text-xs text-content-muted">
                {t(`operations.qualifications.kind.${type.kind}`)}
              </span>
            </label>
          ))}
          {archivedHere.map((requirement) => (
            <label
              key={requirement.qualificationTypeId}
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-muted"
            >
              <input
                type="checkbox"
                checked={chosen.includes(requirement.qualificationTypeId)}
                // Only ever taken off: an archived qualification is nobody's requirement.
                disabled={!chosen.includes(requirement.qualificationTypeId)}
                onChange={(event) => toggle(requirement.qualificationTypeId, event.target.checked)}
              />
              <span dir="auto" className="text-content">
                {requirement.name}
              </span>
              <span className="text-xs text-content-muted">
                {t('operations.qualifications.archivedBadge')}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}

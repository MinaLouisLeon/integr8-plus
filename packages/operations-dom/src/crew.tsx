import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from './api.js';
import { Failure, Loading } from './ui.js';

export interface CrewMember {
  userId: string;
  lead: boolean;
}

/**
 * Choosing a crew: who is on the job, and which one leads.
 *
 * A checkbox per person and a radio for the lead — two native controls, so a
 * keyboard and a screen reader both know what each does. Viewers are not
 * offered: they cannot work a job.
 */
export function CrewPicker({
  value,
  onChange,
}: {
  value: readonly CrewMember[];
  onChange: (crew: CrewMember[]) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const members = useQuery({
    queryKey: keys.members,
    queryFn: async () =>
      (await client.GET('/v1/members', { params: { query: { limit: 200 } } })).data!.items,
  });

  if (members.isPending) {
    return <Loading />;
  }
  if (members.isError) {
    return <Failure error={members.error} onRetry={() => void members.refetch()} />;
  }

  const candidates = members.data.filter(
    (member) => member.status === 'active' && member.role !== 'viewer',
  );
  const on = new Map(value.map((member) => [member.userId, member.lead]));

  const toggle = (userId: string, checked: boolean) => {
    const next = checked
      ? [...value, { userId, lead: value.length === 0 }]
      : value.filter((member) => member.userId !== userId);
    if (next.length > 0 && !next.some((member) => member.lead)) {
      next[0] = { ...next[0]!, lead: true };
    }
    onChange(next);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-content">
        {t('operations.workOrderForm.crew')}
      </legend>
      <ul className="flex flex-col gap-1">
        {candidates.map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 text-sm">
            <label className="flex items-center gap-2 text-content">
              <input
                type="checkbox"
                checked={on.has(member.userId)}
                onChange={(event) => toggle(member.userId, event.target.checked)}
              />
              {member.displayName}
              <span className="text-xs text-content-muted">
                {t(`workspace.role.${member.role}`)}
              </span>
            </label>
            {on.has(member.userId) ? (
              <label className="flex items-center gap-1 text-xs text-content">
                <input
                  type="radio"
                  name="crew-lead"
                  checked={on.get(member.userId) === true}
                  onChange={() =>
                    onChange(
                      value.map((entry) => ({ ...entry, lead: entry.userId === member.userId })),
                    )
                  }
                />
                {t('operations.workOrder.makeLead')}
              </label>
            ) : null}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

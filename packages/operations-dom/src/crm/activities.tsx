import { ACTIVITY_KINDS } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { type Activity, type ActivityKind, keys, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Failure,
  Field,
  fromLocalInput,
  inputClass,
  Loading,
} from '../ui.js';
import { memberName, useMembers } from './lead-parts.js';

/**
 * Follow-ups and the record of what was done (CRM/ERP plan, phase C3): a panel
 * on a lead, an opportunity or a customer, and the to-do list. Reminders by
 * email wait until the company has an email channel; this list is the reminder.
 */

export interface ActivityLinks {
  leadIds?: string[];
  customerIds?: string[];
  opportunityIds?: string[];
}

/** Who did what, what it was about, and — for open ones — a way to mark it done. */
function ActivityItem({
  activity,
  canManage,
  onComplete,
  busy,
  showLinks,
}: {
  activity: Activity;
  canManage: boolean;
  onComplete: (activity: Activity) => void;
  busy: boolean;
  showLinks: boolean;
}) {
  const { t } = useTranslation();
  const { locale, paths, navigate } = useOperations();
  const members = useMembers();
  const assignee = memberName(members.data, activity.assignedTo);
  // When the list was drawn, which is what "overdue" means on it.
  const [now] = useState(() => Date.now());
  const overdue =
    activity.status === 'open' && activity.dueAt !== null && Date.parse(activity.dueAt) < now;

  const link = (href: string, label: string, key: string) => (
    <a
      key={key}
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </a>
  );

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
            {t(`crm.activityKind.${activity.kind}`)}
          </span>
          <span
            className={`font-medium break-words ${activity.status === 'cancelled' ? 'text-content-muted line-through' : 'text-content'}`}
          >
            {activity.subject}
          </span>
        </span>
        <span className="text-xs text-content-muted">
          {[
            activity.status === 'done' && activity.completedAt !== null
              ? t('crm.activities.doneOn', {
                  date: formatDateTime(activity.completedAt, { locale }),
                })
              : activity.dueAt === null
                ? t('crm.activities.noDue')
                : t('crm.activities.dueOn', { date: formatDateTime(activity.dueAt, { locale }) }),
            assignee,
          ]
            .filter(Boolean)
            .join(' · ')}
          {overdue ? (
            <span className="ms-2 font-medium text-danger">{t('crm.activities.overdue')}</span>
          ) : null}
        </span>
        {activity.detail === null ? null : (
          <span className="whitespace-pre-wrap text-content">{activity.detail}</span>
        )}
        {activity.outcome === null ? null : (
          <span className="whitespace-pre-wrap text-content-muted">
            {t('crm.activities.outcomeIs', { outcome: activity.outcome })}
          </span>
        )}
        {showLinks ? (
          <span className="flex flex-wrap gap-x-3 text-xs">
            {activity.leads.map((lead) => link(paths.crmLead(lead.id), lead.displayName, lead.id))}
            {activity.customers.map((customer) =>
              link(paths.customer(customer.id), customer.name, customer.id),
            )}
            {activity.opportunities.map((opportunity) =>
              link(paths.crmOpportunity(opportunity.id), opportunity.title, opportunity.id),
            )}
          </span>
        ) : null}
      </div>
      {canManage && activity.status === 'open' ? (
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={busy}
          onClick={() => onComplete(activity)}
        >
          {t('crm.activities.markDone')}
        </button>
      ) : null}
    </li>
  );
}

/** Marks an activity done, against the version on screen. */
function useCompleteActivity() {
  const { client } = useOperations();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (activity: Activity) =>
      (
        await client.PATCH('/v1/crm/activities/{activityId}', {
          params: { path: { activityId: activity.id } },
          body: { expectedVersion: activity.version, status: 'done' },
        })
      ).data!,
    onSettled: async () => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
    },
  });
}

/** Logs an activity or sets a follow-up on the records it is linked to. */
function NewActivityForm({ links, onDone }: { links: ActivityLinks; onDone: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const members = useMembers();
  const [kind, setKind] = useState<ActivityKind>('follow_up');
  const [subject, setSubject] = useState('');
  const [detail, setDetail] = useState('');
  const [due, setDue] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [done, setDone] = useState(false);

  const body = {
    kind,
    subject: subject.trim(),
    detail: detail.trim() === '' ? null : detail.trim(),
    dueAt: kind === 'note' || due === '' ? null : fromLocalInput(due),
    assignedTo: assignedTo === '' ? null : assignedTo,
    done: kind === 'note' || done,
    ...links,
  };
  const bodyText = JSON.stringify(body);
  const idempotencyKey = useMemo(() => (bodyText === '' ? '' : crypto.randomUUID()), [bodyText]);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/activities', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
      onDone();
    },
  });

  return (
    <form
      aria-label={t('crm.activities.new')}
      className="grid gap-3 rounded-md border border-border-subtle p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.subject !== '') {
          create.mutate();
        }
      }}
    >
      <Field label={t('crm.activities.fields.kind')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as ActivityKind)}
          >
            {ACTIVITY_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`crm.activityKind.${value}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('crm.activities.fields.subject')}>
        {(id) => (
          <input
            id={id}
            required
            maxLength={200}
            className={inputClass}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        )}
      </Field>
      {kind === 'note' ? null : (
        <>
          <Field label={t('crm.activities.fields.due')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className={inputClass}
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('crm.activities.fields.assignee')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
              >
                <option value="">{t('crm.leads.unassigned')}</option>
                {(members.data ?? [])
                  .filter((member) => member.status === 'active')
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        </>
      )}
      <Field label={t('crm.activities.fields.detail')} className="sm:col-span-2">
        {(id) => (
          <textarea
            id={id}
            rows={2}
            maxLength={10_000}
            className={inputClass}
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
          />
        )}
      </Field>
      {kind === 'note' ? null : (
        <label className="flex items-center gap-2 text-sm text-content sm:col-span-2">
          <input
            type="checkbox"
            checked={done}
            onChange={(event) => setDone(event.target.checked)}
          />
          {t('crm.activities.fields.alreadyDone')}
        </label>
      )}
      {create.isError ? (
        <div className="sm:col-span-2">
          <Failure error={create.error} />
        </div>
      ) : null}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button type="button" className={buttonClass.secondary} onClick={onDone}>
          {t('crm.leads.cancel')}
        </button>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={body.subject === '' || create.isPending}
        >
          {create.isPending ? t('crm.leads.saving') : t('crm.activities.save')}
        </button>
      </div>
    </form>
  );
}

/**
 * The activities of one lead, opportunity or customer, newest first, with a
 * form to add one for those who may.
 */
export function ActivityPanel({
  links,
  canManage,
  heading,
}: {
  links: ActivityLinks;
  canManage: boolean;
  heading?: ReactNode;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [adding, setAdding] = useState(false);
  const complete = useCompleteActivity();
  const filter = {
    ...(links.leadIds?.[0] === undefined ? {} : { leadId: links.leadIds[0] }),
    ...(links.customerIds?.[0] === undefined ? {} : { customerId: links.customerIds[0] }),
    ...(links.opportunityIds?.[0] === undefined ? {} : { opportunityId: links.opportunityIds[0] }),
  };
  const list = useInfiniteQuery({
    queryKey: keys.activities({ ...filter, order: 'recent' }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/crm/activities', {
          params: {
            query: {
              ...filter,
              order: 'recent',
              limit: 20,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="crm-activities-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="crm-activities-heading" className="text-lg font-semibold text-content">
          {heading ?? t('crm.activities.heading')}
        </h2>
        {canManage && !adding ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setAdding(true)}>
            {t('crm.activities.new')}
          </button>
        ) : null}
      </div>
      {adding ? <NewActivityForm links={links} onDone={() => setAdding(false)} /> : null}
      {complete.isError ? <Failure error={complete.error} /> : null}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('crm.activities.emptyRecord')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {items.map((activity) => (
            <ActivityItem
              key={activity.id}
              activity={activity}
              canManage={canManage}
              busy={complete.isPending}
              onComplete={(target) => complete.mutate(target)}
              showLinks={false}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('crm.leads.loadMore')}
        </button>
      ) : null}
    </section>
  );
}

type Tab = 'overdue' | 'today' | 'upcoming' | 'none' | 'done';
const TABS: readonly Tab[] = ['overdue', 'today', 'upcoming', 'none', 'done'];

/** The to-do list: open follow-ups by when they are due, mine or everyone's. */
export function ActivitiesScreen() {
  const { t } = useTranslation();
  const { client, paths } = useOperations();
  const [tab, setTab] = useState<Tab>('overdue');
  const [mine, setMine] = useState(true);
  const complete = useCompleteActivity();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManage = me.data?.permissions.includes('crm.activity.manage') ?? false;

  const query = {
    ...(tab === 'done' ? { status: ['done' as const] } : { status: ['open' as const], due: tab }),
    ...(mine ? { assignedTo: 'me' } : {}),
    order: tab === 'done' ? ('recent' as const) : ('due' as const),
  };
  const list = useInfiniteQuery({
    queryKey: keys.activities(query),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/crm/activities', {
          params: {
            query: {
              ...query,
              limit: 50,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crm} label={t('nav.backTo', { title: t('crm.overview.title') })} />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('crm.activities.title')}</h1>
        <p className="text-sm text-content-muted">{t('crm.activities.intro')}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('crm.activities.title')} className="flex flex-wrap gap-1">
          {TABS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? buttonClass.primary : buttonClass.secondary}
              onClick={() => setTab(value)}
            >
              {t(`crm.activities.tab.${value}`)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => setMine(event.target.checked)}
          />
          {t('crm.activities.onlyMine')}
        </label>
      </div>

      {complete.isError ? <Failure error={complete.error} /> : null}
      <section role="tabpanel" aria-label={t(`crm.activities.tab.${tab}`)} className={cardClass}>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <Failure error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-content-muted">{t('crm.activities.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {items.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                canManage={canManage}
                busy={complete.isPending}
                onComplete={(target) => complete.mutate(target)}
                showLinks
              />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <button
            type="button"
            className={`${buttonClass.secondary} self-center`}
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('crm.leads.loadMore')}
          </button>
        ) : null}
      </section>
    </div>
  );
}

import { ApiRequestError, type paths } from '@integr8/api-client';
import { apiErrorMessage, formatDateTime, formatPercent, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useShellChrome } from '~/components/shell-chrome';
import { Button, EmptyState, ErrorState, Field, LoadingState, Shell } from '~/components/ui';
import { type Me, useMe } from '~/features/forms/api';
import {
  type Allowance,
  parseShareInput,
  shareRefusal,
  shareText,
  summariseAllowance,
  unassignedPercent,
} from '~/lib/ai-shares';
import { session } from '~/lib/session';

/**
 * The assistant's switches (docs/ai; ADR-0001).
 *
 * The web app keeps these on its company settings and people pages; neither
 * page exists here, so the desktop has this one screen for both: at the top,
 * which apps show the assistant for the whole company (`tenant.update`), and
 * below, each member's own switch (`member.update_role` to throw it, `member.read`
 * to see where it stands). A seat holding neither is sent to the dashboard.
 *
 * Seats that throw the switches also divide the company's allowance
 * (ADR-0002 D6): each member's share is a whole percentage of it, the shares
 * total 100 or less, and a member needs both the switch and a share. Only
 * percentages appear here — never a token count, a message count or a price
 * (D7); the platform alone sees those.
 *
 * Whether the assistant is included at all is Integr8's call and the plan's;
 * these switches only ever close a door the plan has opened, which is why the
 * intro says so before the first checkbox.
 */

const SETTINGS_KEY = ['settings'] as const;
const MEMBERS_KEY = ['members'] as const;
const CAPABILITIES_KEY = ['ai', 'capabilities'] as const;
const SHARES_KEY = ['ai', 'shares'] as const;

type Channel = 'web' | 'desktop' | 'mobile';

const CHANNEL_FIELDS: Readonly<
  Record<Channel, 'aiWebEnabled' | 'aiDesktopEnabled' | 'aiMobileEnabled'>
> = {
  web: 'aiWebEnabled',
  desktop: 'aiDesktopEnabled',
  mobile: 'aiMobileEnabled',
};

const CHANNELS: readonly Channel[] = ['web', 'desktop', 'mobile'];

type Channels = Record<Channel, boolean>;

export function AssistantSettingsRoute() {
  const { t } = useTranslation();
  const me = useMe();
  useShellChrome({ title: t('workspace.settings.ai.title') });

  if (me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (me.isError) {
    return (
      <Shell>
        <ErrorState
          requestId={me.error instanceof ApiRequestError ? me.error.requestId : undefined}
          onRetry={() => void me.refetch()}
        />
      </Shell>
    );
  }

  const maySetChannels = me.data.permissions.includes('tenant.update');
  const mayReadMembers = me.data.permissions.includes('member.read');
  if (!maySetChannels && !mayReadMembers) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <Shell>
      <div className="flex flex-col gap-8 px-6 py-8 text-start">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">
            {t('workspace.settings.ai.title')}
          </h1>
          <p className="text-sm text-content-muted">{t('workspace.settings.ai.intro')}</p>
        </header>

        {maySetChannels ? <ChannelSettings /> : null}
        {mayReadMembers ? <MemberSwitches viewer={me.data} /> : null}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Which apps show the assistant
// ---------------------------------------------------------------------------

function ChannelSettings() {
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => (await session().client.GET('/v1/settings')).data!,
  });

  if (settings.isPending) {
    return <LoadingState />;
  }
  if (settings.isError) {
    return (
      <ErrorState
        requestId={settings.error instanceof ApiRequestError ? settings.error.requestId : undefined}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  return (
    <ChannelForm
      key={CHANNELS.map((channel) => settings.data[CHANNEL_FIELDS[channel]]).join()}
      initial={{
        web: settings.data.aiWebEnabled,
        desktop: settings.data.aiDesktopEnabled,
        mobile: settings.data.aiMobileEnabled,
      }}
    />
  );
}

function ChannelForm({ initial }: { initial: Channels }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<Channels>(initial);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (next: Channels) => {
      const { data } = await session().client.PATCH('/v1/settings', {
        body: {
          aiWebEnabled: next.web,
          aiDesktopEnabled: next.desktop,
          aiMobileEnabled: next.mobile,
        },
      });
      return data!;
    },
    onSuccess: () => {
      setSaved(true);
      void queries.invalidateQueries({ queryKey: SETTINGS_KEY });
      // The menu's assistant row follows the desktop switch.
      void queries.invalidateQueries({ queryKey: CAPABILITIES_KEY });
    },
    onError: () => {
      setSaved(false);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft);
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        {CHANNELS.map((channel) => (
          <label key={channel} className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={draft[channel]}
              disabled={save.isPending}
              onChange={(event) => {
                const checked = event.target.checked;
                setSaved(false);
                setDraft((current) => ({ ...current, [channel]: checked }));
              }}
            />
            {t(`workspace.settings.ai.${channel}`)}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" busy={save.isPending}>
          {t('workspace.settings.save')}
        </Button>
        {saved ? (
          <span role="status" className="text-sm text-content-muted">
            {t('workspace.settings.saved')}
          </span>
        ) : null}
        {save.isError ? (
          <span role="alert" className="text-sm text-danger">
            {t('workspace.settings.ai.failed')}
          </span>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Who may use it
// ---------------------------------------------------------------------------

function MemberSwitches({ viewer }: { viewer: Me }) {
  const { t } = useTranslation();
  const headingId = useId();
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: async () => (await session().client.GET('/v1/members')).data!.items,
  });
  const mayToggle = viewer.permissions.includes('member.update_role');
  // Shares are read with the same permission that sets them; a seat that can
  // only look at the switches is never asked for them.
  const shares = useQuery({
    queryKey: SHARES_KEY,
    queryFn: async () => (await session().client.GET('/v1/ai/shares')).data!,
    enabled: mayToggle,
  });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold text-content">
          {t('workspace.settings.ai.members')}
        </h2>
        <p className="text-sm text-content-muted">{t('workspace.settings.ai.membersHint')}</p>
        {mayToggle ? (
          <p className="text-sm text-content-muted">{t('workspace.settings.ai.bothNeeded')}</p>
        ) : null}
      </div>
      {!mayToggle ? null : shares.isError ? (
        <ErrorState
          requestId={shares.error instanceof ApiRequestError ? shares.error.requestId : undefined}
          onRetry={() => void shares.refetch()}
        />
      ) : shares.data === undefined ? null : (
        <CompanyAllowance
          allowance={shares.data.company.allowance}
          assignedPercent={shares.data.company.assignedPercent}
        />
      )}
      {members.isPending ? (
        <LoadingState />
      ) : members.isError ? (
        <ErrorState
          requestId={members.error instanceof ApiRequestError ? members.error.requestId : undefined}
          onRetry={() => void members.refetch()}
        />
      ) : members.data.length === 0 ? (
        <EmptyState title={t('workspace.members.title')} body={t('workspace.members.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {members.data.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              mayToggle={mayToggle}
              share={shares.data?.items.find((row) => row.userId === member.userId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type Member =
  paths['/v1/members']['get']['responses'][200]['content']['application/json']['items'][number];

type Shares = paths['/v1/ai/shares']['get']['responses'][200]['content']['application/json'];
type ShareRow = Shares['items'][number];

/** The company's allowance: what is left of it, and how much of it the shares hold. */
function CompanyAllowance({
  allowance,
  assignedPercent,
}: {
  allowance: Allowance;
  assignedPercent: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const percent = (value: number) => formatPercent(value / 100, { locale });
  const summary = summariseAllowance(allowance);
  const when =
    summary.kind === 'unlimited' || summary.resetsAt === null
      ? null
      : formatDateTime(summary.resetsAt, { locale });

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-muted px-3 py-2 text-sm text-content">
      <p>
        {summary.kind === 'unlimited'
          ? t('workspace.settings.ai.memberShares.companyUnlimited')
          : summary.kind === 'usedUp'
            ? when === null
              ? t('workspace.settings.ai.memberShares.companyUsedUp')
              : t('workspace.settings.ai.memberShares.companyUsedUpResets', { when })
            : when === null
              ? t('workspace.settings.ai.memberShares.companyLeft', {
                  percent: percent(summary.percent),
                })
              : t('workspace.settings.ai.memberShares.companyLeftResets', {
                  percent: percent(summary.percent),
                  when,
                })}
      </p>
      <p className="text-content-muted">
        {t('workspace.settings.ai.memberShares.assigned', {
          assigned: percent(Math.min(100, assignedPercent)),
          unassigned: percent(unassignedPercent(assignedPercent)),
        })}
      </p>
    </div>
  );
}

function MemberRow({
  member,
  mayToggle,
  share,
}: {
  member: Member;
  mayToggle: boolean;
  /** The member's share, for a seat that sets them; absent for anybody not yet active. */
  share?: ShareRow | undefined;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const toggle = useMutation({
    mutationFn: async (aiEnabled: boolean) => {
      await session().client.PATCH('/v1/members/{userId}/ai', {
        params: { path: { userId: member.userId } },
        body: { aiEnabled },
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: MEMBERS_KEY });
      void queries.invalidateQueries({ queryKey: SHARES_KEY });
      // The member's own menu follows this switch.
      void queries.invalidateQueries({ queryKey: CAPABILITIES_KEY });
    },
  });

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-content">{member.displayName}</span>
        <span className="min-w-0 truncate text-content-muted">{member.email}</span>
        <span className="text-xs text-content-muted">{t(`workspace.role.${member.role}`)}</span>
        <span className="text-xs text-content-muted">
          {t(`workspace.members.status.${member.status}`)}
        </span>
        <span className="ms-auto">
          {mayToggle ? (
            <label className="flex items-center gap-1.5 text-xs text-content">
              <input
                type="checkbox"
                checked={member.aiEnabled}
                disabled={toggle.isPending}
                aria-label={t('workspace.members.ai.toggle', { name: member.displayName })}
                onChange={(event) => toggle.mutate(event.target.checked)}
              />
              {t('workspace.members.ai.label')}
            </label>
          ) : (
            <span className="text-xs text-content-muted">
              {member.aiEnabled ? t('workspace.members.ai.on') : t('workspace.members.ai.off')}
            </span>
          )}
        </span>
      </div>
      {toggle.isError ? (
        <p role="alert" className="text-xs text-danger">
          {t('workspace.settings.ai.failed')}
        </p>
      ) : null}
      {mayToggle && share !== undefined ? <ShareEditor share={share} /> : null}
    </li>
  );
}

/**
 * One member's share: a whole percentage, or empty for none. Saved with the
 * version last read, so two admins saving at once cannot overwrite each other
 * unseen; the loser is told and shown the share as it now is.
 */
function ShareEditor({ share }: { share: ShareRow }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const queries = useQueryClient();
  const [draft, setDraft] = useState(shareText(share.sharePercent));
  const [invalid, setInvalid] = useState(false);
  // When the saved share changes under the box (a save, or somebody else's
  // seen after a conflict), the box follows it rather than keep a stale number.
  const [shown, setShown] = useState(share.sharePercent);
  if (share.sharePercent !== shown) {
    setShown(share.sharePercent);
    setDraft(shareText(share.sharePercent));
  }

  const save = useMutation({
    mutationFn: async (sharePercent: number | null) =>
      (
        await session().client.PUT('/v1/ai/shares/{userId}', {
          params: { path: { userId: share.userId } },
          body: { sharePercent, expectedVersion: share.version },
        })
      ).data!,
    onSuccess: (saved) => {
      // The row's new version is needed by the next save at once, before the
      // list is read again for the company's assigned total.
      queries.setQueryData<Shares>(SHARES_KEY, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              items: current.items.map((row) => (row.userId === saved.userId ? saved : row)),
            },
      );
      void queries.invalidateQueries({ queryKey: SHARES_KEY });
      // An admin who changed their own share sees their assistant follow it.
      void queries.invalidateQueries({ queryKey: CAPABILITIES_KEY });
    },
    onError: (error) => {
      if (shareRefusal(error)?.kind === 'changed') {
        void queries.invalidateQueries({ queryKey: SHARES_KEY });
      }
    },
  });

  const parsed = parseShareInput(draft);
  const dirty = !parsed.ok || parsed.sharePercent !== share.sharePercent;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    save.mutate(parsed.sharePercent);
  };

  const percent = (value: number) => formatPercent(value / 100, { locale });
  const refusal = save.isError ? shareRefusal(save.error) : null;
  const problem = invalid
    ? t('workspace.settings.ai.memberShares.invalid')
    : !save.isError
      ? undefined
      : refusal?.kind === 'changed'
        ? t('workspace.settings.ai.memberShares.changed')
        : refusal?.kind === 'outranked'
          ? t('workspace.settings.ai.memberShares.outranked')
          : refusal?.kind === 'overTotal' && refusal.availablePercent !== null
            ? t('workspace.settings.ai.memberShares.overTotal', {
                available: percent(refusal.availablePercent),
              })
            : apiErrorMessage(save.error, t);

  const summary = summariseAllowance(share.allowance);
  const when =
    summary.kind === 'unlimited' || summary.resetsAt === null
      ? null
      : formatDateTime(summary.resetsAt, { locale });
  const remaining =
    share.sharePercent === null
      ? t('workspace.settings.ai.memberShares.none')
      : summary.kind === 'unlimited'
        ? null
        : summary.kind === 'usedUp'
          ? when === null
            ? t('workspace.settings.ai.memberShares.usedUp')
            : t('workspace.settings.ai.memberShares.usedUpResets', { when })
          : when === null
            ? t('workspace.settings.ai.memberShares.left', { percent: percent(summary.percent) })
            : t('workspace.settings.ai.memberShares.leftResets', {
                percent: percent(summary.percent),
                when,
              });

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-wrap items-end gap-3 border-t border-border-subtle pt-2"
    >
      <div className="w-40">
        <Field
          label={t('workspace.settings.ai.memberShares.label')}
          aria-label={t('workspace.settings.ai.memberShares.shareFor', {
            name: share.displayName,
          })}
          inputMode="numeric"
          autoComplete="off"
          placeholder={t('workspace.settings.ai.memberShares.placeholder')}
          value={draft}
          disabled={save.isPending}
          error={problem}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
            save.reset();
          }}
        />
      </div>
      <Button type="submit" variant="secondary" busy={save.isPending} disabled={!dirty}>
        {t('workspace.settings.ai.memberShares.save')}
      </Button>
      <div className="flex min-w-0 flex-col gap-0.5 pb-2 text-xs text-content-muted">
        {remaining === null ? null : <span>{remaining}</span>}
        {save.isSuccess && !dirty ? (
          <span role="status">{t('workspace.settings.ai.memberShares.saved')}</span>
        ) : null}
      </div>
    </form>
  );
}

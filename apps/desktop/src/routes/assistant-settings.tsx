import { ApiRequestError, type paths } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useShellChrome } from '~/components/shell-chrome';
import { Button, EmptyState, ErrorState, LoadingState, Shell } from '~/components/ui';
import { type Me, useMe } from '~/features/forms/api';
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
 * Whether the assistant is included at all is Integr8's call and the plan's;
 * these switches only ever close a door the plan has opened, which is why the
 * intro says so before the first checkbox.
 */

const SETTINGS_KEY = ['settings'] as const;
const MEMBERS_KEY = ['members'] as const;
const CAPABILITIES_KEY = ['ai', 'capabilities'] as const;

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

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold text-content">
          {t('workspace.settings.ai.members')}
        </h2>
        <p className="text-sm text-content-muted">{t('workspace.settings.ai.membersHint')}</p>
      </div>
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
            <MemberRow key={member.userId} member={member} mayToggle={mayToggle} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Member =
  paths['/v1/members']['get']['responses'][200]['content']['application/json']['items'][number];

function MemberRow({ member, mayToggle }: { member: Member; mayToggle: boolean }) {
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
    </li>
  );
}

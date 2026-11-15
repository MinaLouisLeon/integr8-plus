-- Company people, roles, sign-in, sessions, devices and the audit log.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.reject_audit_log_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'audit_log is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

CREATE FUNCTION public.reject_platform_user_membership() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if exists (select 1 from platform_users where id = new.user_id) then
    raise exception
      'user_id % is a platform_users identity and cannot hold a tenant membership', new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.tenant_roles_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.base_role is distinct from old.base_role then
    raise exception 'A role keeps the base it was built on'
      using errcode = 'check_violation', constraint = 'tenant_roles_base_fixed';
  end if;
  if new.archived_at is not null and old.archived_at is null and exists (
    select 1 from tenant_users u where u.tenant_id = new.tenant_id and u.custom_role_id = new.id
  ) then
    raise exception 'A role somebody holds is not archived'
      using errcode = 'check_violation', constraint = 'tenant_roles_in_use';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.tenant_users_custom_role_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  base text;
begin
  if new.custom_role_id is null then
    return new;
  end if;
  select r.base_role into base
    from tenant_roles r
   where r.tenant_id = new.tenant_id and r.id = new.custom_role_id and r.archived_at is null;
  if base is null then
    raise exception 'The role does not exist or is archived'
      using errcode = 'check_violation', constraint = 'tenant_users_custom_role_usable';
  end if;
  if new.role is distinct from base then
    raise exception 'A member''s role is their custom role''s base'
      using errcode = 'check_violation', constraint = 'tenant_users_custom_role_base';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE account_locks (
    email text NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    last_failure_at timestamp with time zone,
    locked_at timestamp with time zone,
    locked_until timestamp with time zone,
    unlocked_at timestamp with time zone,
    unlocked_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_locks_email_lowercase CHECK ((email = lower(email))),
    CONSTRAINT account_locks_failed_count_sane CHECK ((failed_count >= 0)),
    CONSTRAINT account_locks_locked_pair CHECK (((locked_at IS NULL) = (locked_until IS NULL)))
);

CREATE TABLE audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid,
    actor_label text NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    request_id uuid,
    ip_address inet,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_log_action_not_blank CHECK ((btrim(action) <> ''::text)),
    CONSTRAINT audit_log_actor_id_present CHECK (((actor_kind = 'system'::text) = (actor_id IS NULL))),
    CONSTRAINT audit_log_actor_kind_known CHECK ((actor_kind = ANY (ARRAY['tenant_user'::text, 'platform_user'::text, 'system'::text]))),
    CONSTRAINT audit_log_resource_type_not_blank CHECK ((btrim(resource_type) <> ''::text))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE tenant_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    custom_role_id uuid,
    ai_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT tenant_users_display_name_not_blank CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT tenant_users_email_lowercase CHECK ((email = lower(email))),
    CONSTRAINT tenant_users_email_shaped CHECK ((email ~~ '%_@_%'::text)),
    CONSTRAINT tenant_users_role_known CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'hr_manager'::text, 'inventory_manager'::text, 'accountant'::text, 'dispatcher'::text, 'engineer'::text, 'viewer'::text]))),
    CONSTRAINT tenant_users_status_known CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text])))
);

CREATE TABLE identity_deletions (
    user_id uuid NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    last_error text,
    completed_at timestamp with time zone,
    CONSTRAINT identity_deletions_attempts_sane CHECK ((attempts >= 0))
);

CREATE TABLE impersonation_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    platform_user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    reason text NOT NULL,
    audit_log_id uuid NOT NULL,
    audit_log_occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    ended_reason text,
    from_limited_session boolean DEFAULT false NOT NULL,
    CONSTRAINT impersonation_grants_ended_pair CHECK (((ended_at IS NULL) = (ended_reason IS NULL))),
    CONSTRAINT impersonation_grants_ended_reason_known CHECK (((ended_reason IS NULL) OR (ended_reason = ANY (ARRAY['ended_by_admin'::text, 'expired'::text, 'revoked_by_tenant'::text])))),
    CONSTRAINT impersonation_grants_expires_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT impersonation_grants_reason_meaningful CHECK ((length(btrim(reason)) >= 10))
);

CREATE TABLE invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_user_id uuid,
    revoked_at timestamp with time zone,
    revoked_by_user_id uuid,
    CONSTRAINT invitations_accepted_pair CHECK (((accepted_at IS NULL) = (accepted_user_id IS NULL))),
    CONSTRAINT invitations_email_lowercase CHECK ((email = lower(email))),
    CONSTRAINT invitations_email_shaped CHECK ((email ~~ '%_@_%'::text)),
    CONSTRAINT invitations_expires_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT invitations_hash_is_sha256 CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT invitations_revoked_pair CHECK (((revoked_at IS NULL) = (revoked_by_user_id IS NULL))),
    CONSTRAINT invitations_role_known CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'hr_manager'::text, 'inventory_manager'::text, 'accountant'::text, 'dispatcher'::text, 'engineer'::text, 'viewer'::text]))),
    CONSTRAINT invitations_single_outcome CHECK (((accepted_at IS NULL) OR (revoked_at IS NULL)))
);

CREATE TABLE login_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    ip_address inet,
    user_agent text,
    outcome text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT login_attempts_email_lowercase CHECK ((email = lower(email))),
    CONSTRAINT login_attempts_outcome_known CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'bad_credentials'::text, 'unknown_identity'::text, 'locked_out'::text, 'no_membership'::text, 'rate_limited'::text])))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE member_grants (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    capability text NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_grants_capability_known CHECK ((capability = ANY (ARRAY['hr_manager'::text, 'inventory_manager'::text])))
);

CREATE TABLE offline_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    device_label text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    CONSTRAINT offline_grants_expires_after_issue CHECK ((expires_at > issued_at)),
    CONSTRAINT offline_grants_revoked_pair CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL))),
    CONSTRAINT offline_grants_revoked_reason_known CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['device_lost'::text, 'revoked_by_admin'::text, 'session_revoked'::text, 'membership_ended'::text, 'replaced'::text]))))
);

CREATE TABLE push_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    token text NOT NULL,
    platform text NOT NULL,
    device_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_registered_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    disabled_reason text,
    locale text,
    CONSTRAINT push_devices_disabled_pair CHECK (((disabled_at IS NULL) = (disabled_reason IS NULL))),
    CONSTRAINT push_devices_disabled_reason_known CHECK (((disabled_reason IS NULL) OR (disabled_reason = ANY (ARRAY['signed_out'::text, 'not_registered'::text, 'replaced'::text])))),
    CONSTRAINT push_devices_label_length CHECK ((COALESCE(char_length(device_label), 0) <= 200)),
    CONSTRAINT push_devices_locale_known CHECK (((locale IS NULL) OR (locale = ANY (ARRAY['en'::text, 'ar'::text])))),
    CONSTRAINT push_devices_platform_known CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text]))),
    CONSTRAINT push_devices_token_shape CHECK ((token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'::text))
);

CREATE TABLE refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    session_id uuid NOT NULL,
    token_hash text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    replaced_by uuid,
    CONSTRAINT refresh_tokens_hash_is_sha256 CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refresh_tokens_replacement_pair CHECK (((used_at IS NULL) = (replaced_by IS NULL)))
);

CREATE TABLE sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_app text NOT NULL,
    device_label text,
    user_agent text,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    impersonation_grant_id uuid,
    signed_in_with text DEFAULT 'password'::text NOT NULL,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_client_app_known CHECK ((client_app = ANY (ARRAY['web'::text, 'desktop'::text, 'mobile'::text, 'api'::text]))),
    CONSTRAINT sessions_expires_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT sessions_revoked_pair CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL))),
    CONSTRAINT sessions_revoked_reason_known CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['signed_out'::text, 'signed_out_everywhere'::text, 'refresh_token_reuse'::text, 'revoked_by_admin'::text, 'membership_ended'::text, 'impersonation_ended'::text, 'password_changed'::text])))),
    CONSTRAINT sessions_signed_in_with_known CHECK ((signed_in_with = ANY (ARRAY['password'::text, 'email_code'::text, 'invitation'::text, 'signup'::text, 'impersonation'::text])))
);

CREATE TABLE tenant_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    base_role text NOT NULL,
    added text[] DEFAULT '{}'::text[] NOT NULL,
    removed text[] DEFAULT '{}'::text[] NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT tenant_roles_base_known CHECK ((base_role = ANY (ARRAY['admin'::text, 'hr_manager'::text, 'inventory_manager'::text, 'accountant'::text, 'dispatcher'::text, 'engineer'::text, 'viewer'::text]))),
    CONSTRAINT tenant_roles_description_length CHECK (((description IS NULL) OR (char_length(description) <= 500))),
    CONSTRAINT tenant_roles_lists_sane CHECK (((cardinality(added) <= 200) AND (cardinality(removed) <= 200) AND (NOT (added && removed)))),
    CONSTRAINT tenant_roles_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 60))),
    CONSTRAINT tenant_roles_version_positive CHECK ((version > 0))
);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

CREATE VIEW auth_memberships WITH (security_invoker='false') AS
 SELECT tu.tenant_id,
    tu.user_id,
    tu.role,
    tu.status
   FROM (tenant_users tu
     JOIN tenants t ON ((t.id = tu.tenant_id)))
  WHERE ((tu.deleted_at IS NULL) AND (t.deleted_at IS NULL) AND (t.status = 'active'::text));

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY account_locks
    ADD CONSTRAINT account_locks_pkey PRIMARY KEY (email);

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (tenant_id, id, occurred_at);

ALTER TABLE ONLY identity_deletions
    ADD CONSTRAINT identity_deletions_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY impersonation_grants
    ADD CONSTRAINT impersonation_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY impersonation_grants
    ADD CONSTRAINT impersonation_grants_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash);

ALTER TABLE login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id, occurred_at);

ALTER TABLE ONLY member_grants
    ADD CONSTRAINT member_grants_pkey PRIMARY KEY (tenant_id, user_id, capability);

ALTER TABLE ONLY offline_grants
    ADD CONSTRAINT offline_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY offline_grants
    ADD CONSTRAINT offline_grants_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_token_unique UNIQUE (tenant_id, token);

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash);

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY tenant_roles
    ADD CONSTRAINT tenant_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenant_roles
    ADD CONSTRAINT tenant_roles_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY tenant_users
    ADD CONSTRAINT tenant_users_email_per_tenant_unique UNIQUE (tenant_id, email);

ALTER TABLE ONLY tenant_users
    ADD CONSTRAINT tenant_users_membership_unique UNIQUE (tenant_id, user_id);

ALTER TABLE ONLY tenant_users
    ADD CONSTRAINT tenant_users_pkey PRIMARY KEY (id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX audit_log_resource_idx ON audit_log USING btree (tenant_id, resource_type, resource_id);

CREATE INDEX audit_log_tenant_time_idx ON audit_log USING btree (tenant_id, occurred_at DESC);

CREATE INDEX identity_deletions_pending_idx ON identity_deletions USING btree (queued_at) WHERE (completed_at IS NULL);

CREATE INDEX impersonation_grants_by_platform_user_idx ON impersonation_grants USING btree (platform_user_id, created_at DESC);

CREATE INDEX impersonation_grants_live_idx ON impersonation_grants USING btree (tenant_id, expires_at) WHERE (ended_at IS NULL);

CREATE UNIQUE INDEX invitations_one_live_per_email ON invitations USING btree (tenant_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

CREATE INDEX invitations_pending_idx ON invitations USING btree (tenant_id, expires_at) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

CREATE INDEX login_attempts_email_time_idx ON login_attempts USING btree (email, occurred_at DESC);

CREATE INDEX login_attempts_ip_time_idx ON login_attempts USING btree (ip_address, occurred_at DESC) WHERE (ip_address IS NOT NULL);

CREATE INDEX login_attempts_occurred_at_idx ON login_attempts USING btree (occurred_at);

CREATE INDEX offline_grants_live_idx ON offline_grants USING btree (tenant_id, user_id) WHERE (revoked_at IS NULL);

CREATE INDEX push_devices_person_idx ON push_devices USING btree (tenant_id, user_id) WHERE (disabled_at IS NULL);

CREATE INDEX refresh_tokens_live_idx ON refresh_tokens USING btree (expires_at) WHERE (used_at IS NULL);

CREATE INDEX refresh_tokens_session_idx ON refresh_tokens USING btree (tenant_id, session_id);

CREATE INDEX sessions_expiry_idx ON sessions USING btree (expires_at) WHERE (revoked_at IS NULL);

CREATE INDEX sessions_live_idx ON sessions USING btree (tenant_id, user_id) WHERE (revoked_at IS NULL);

CREATE UNIQUE INDEX tenant_roles_name_unique ON tenant_roles USING btree (tenant_id, lower(btrim(name))) WHERE (archived_at IS NULL);

CREATE INDEX tenant_users_custom_role_idx ON tenant_users USING btree (tenant_id, custom_role_id) WHERE (custom_role_id IS NOT NULL);

CREATE INDEX tenant_users_tenant_active_idx ON tenant_users USING btree (tenant_id) WHERE (deleted_at IS NULL);

CREATE INDEX tenant_users_user_id_idx ON tenant_users USING btree (user_id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY impersonation_grants
    ADD CONSTRAINT impersonation_grants_audit_fk FOREIGN KEY (tenant_id, audit_log_id, audit_log_occurred_at) REFERENCES audit_log(tenant_id, id, occurred_at) ON DELETE RESTRICT;

ALTER TABLE ONLY impersonation_grants
    ADD CONSTRAINT impersonation_grants_platform_user_id_fkey FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY impersonation_grants
    ADD CONSTRAINT impersonation_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY member_grants
    ADD CONSTRAINT member_grants_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY member_grants
    ADD CONSTRAINT member_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY offline_grants
    ADD CONSTRAINT offline_grants_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY offline_grants
    ADD CONSTRAINT offline_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY push_devices
    ADD CONSTRAINT push_devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_replacement_fk FOREIGN KEY (tenant_id, replaced_by) REFERENCES refresh_tokens(tenant_id, id) ON DELETE SET NULL;

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY refresh_tokens
    ADD CONSTRAINT refresh_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_impersonation_grant_fk FOREIGN KEY (tenant_id, impersonation_grant_id) REFERENCES impersonation_grants(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_roles
    ADD CONSTRAINT tenant_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_users
    ADD CONSTRAINT tenant_users_custom_role_fk FOREIGN KEY (tenant_id, custom_role_id) REFERENCES tenant_roles(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_users
    ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER account_locks_set_updated_at BEFORE UPDATE ON account_locks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER tenant_roles_guard BEFORE UPDATE ON tenant_roles FOR EACH ROW EXECUTE FUNCTION tenant_roles_guard();

CREATE TRIGGER tenant_roles_set_updated_at BEFORE UPDATE ON tenant_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tenant_users_custom_role_guard BEFORE INSERT OR UPDATE OF role, custom_role_id ON tenant_users FOR EACH ROW EXECUTE FUNCTION tenant_users_custom_role_guard();

CREATE TRIGGER tenant_users_reject_platform_user BEFORE INSERT OR UPDATE OF user_id ON tenant_users FOR EACH ROW EXECUTE FUNCTION reject_platform_user_membership();

CREATE TRIGGER tenant_users_set_updated_at BEFORE UPDATE ON tenant_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE account_locks ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE identity_deletions ENABLE ROW LEVEL SECURITY;

ALTER TABLE impersonation_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE member_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE offline_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_locks_pre_auth ON account_locks TO integr8_auth USING (true) WITH CHECK (true);

CREATE POLICY audit_log_append_own ON audit_log FOR INSERT TO integr8_app WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY audit_log_read_own ON audit_log FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY impersonation_grants_isolation ON impersonation_grants TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY invitations_isolation ON invitations TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY login_attempts_pre_auth ON login_attempts TO integr8_auth USING (true) WITH CHECK (true);

CREATE POLICY member_grants_isolation ON member_grants TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY offline_grants_isolation ON offline_grants TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY push_devices_isolation ON push_devices TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY refresh_tokens_isolation ON refresh_tokens TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY sessions_isolation ON sessions TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_roles_isolation ON tenant_roles TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_users_isolation ON tenant_users TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION reject_platform_user_membership() IS 'Refuses a tenant membership for a platform_users identity. Security definer so the runtime role, which cannot read platform_users, can still be checked against it; search_path is pinned.';

COMMENT ON TABLE account_locks IS 'Lockout state per address. `unlocked_by` records the admin who lifted it, so an unlock is attributable.';

COMMENT ON COLUMN account_locks.unlocked_by IS 'Free text: "admin:<uuid>", "platform:<uuid>" or "auto". Not a foreign key — an unlock can come from either identity space.';

COMMENT ON TABLE audit_log IS 'Append-only record of consequential actions. Updates and deletes are rejected by trigger, for every role including the owner.';

COMMENT ON COLUMN audit_log.tenant_id IS 'Non-null: every audited action concerns a company. Platform events touching no tenant get their own table when P03 needs one.';

COMMENT ON COLUMN audit_log.actor_label IS 'Denormalised actor email (or the literal system). Kept verbatim so the log still reads correctly after the actor is renamed or removed.';

COMMENT ON TABLE tenant_users IS 'Membership: which person belongs to which company, in what role.';

COMMENT ON COLUMN tenant_users.user_id IS 'The auth identity (auth.users.id once P03 lands). Not a foreign key: auth lives in another schema.';

COMMENT ON COLUMN tenant_users.ai_enabled IS 'Whether this member may use the assistant when the company has it (ADR-0001). Set by owners and admins.';

COMMENT ON VIEW auth_memberships IS 'Sign-in only: which active companies an identity belongs to. Deliberately bypasses RLS; granted to integr8_auth alone.';

COMMENT ON TABLE identity_deletions IS 'Sign-in accounts to delete from Auth after a purge, retried until done. Platform only.';

COMMENT ON COLUMN impersonation_grants.audit_log_occurred_at IS 'When the audit line was written: with audit_log_id it names the line in the year-partitioned audit log (P41).';

COMMENT ON TABLE impersonation_grants IS 'A time-limited grant for a super admin to act as a tenant user. Cannot exist without its audit entry.';

COMMENT ON COLUMN impersonation_grants.from_limited_session IS 'Started from a staff session limited to test companies (0077): the developer MCP server.';

COMMENT ON TABLE invitations IS 'Pending membership. The emailed token is stored only as a hash; acceptance binds the invitee to this tenant at this role.';

COMMENT ON TABLE login_attempts IS 'Every sign-in attempt, successful or not. Keyed on email because at attempt time no tenant is known.';

COMMENT ON TABLE member_grants IS 'Capabilities a member holds on top of their role (ADR-0010). Read when an access token is minted.';

COMMENT ON TABLE offline_grants IS 'Records a long-lived grant so it can be revoked. Revocation only bites once the device is online again.';

COMMENT ON TABLE push_devices IS 'Where to send a person push notifications: an Expo push token per phone, tied to the session that registered it.';

COMMENT ON TABLE refresh_tokens IS 'Rotating refresh tokens, stored as SHA-256 hashes. A reused token means theft; see refresh_tokens_replacement_pair.';

COMMENT ON TABLE sessions IS 'One signed-in device, for one company. The unit an admin revokes and the unit an access token is minted from.';

COMMENT ON COLUMN sessions.impersonation_grant_id IS 'Set when this session exists only because a super admin is impersonating. Ordinary sign-in leaves it null.';

COMMENT ON COLUMN sessions.signed_in_with IS 'How the person proved who they are: password, email_code, invitation, signup or impersonation. Copied on a company switch.';

COMMENT ON COLUMN sessions.authenticated_at IS 'When the person last proved who they are. Copied on a company switch, so a code sign-in stays fresh for fifteen minutes wherever they go.';

COMMENT ON TABLE tenant_roles IS 'A company''s own roles (ADR-0013): a built-in base and the permissions added to or taken from it. Read when an access token is minted.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,UPDATE ON TABLE account_locks TO integr8_auth;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE account_locks TO integr8_platform;

GRANT SELECT,INSERT ON TABLE audit_log TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE audit_log TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_users TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_users TO integr8_platform;

GRANT SELECT ON TABLE auth_memberships TO integr8_auth;
GRANT SELECT ON TABLE auth_memberships TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE identity_deletions TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE impersonation_grants TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE impersonation_grants TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE invitations TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE invitations TO integr8_platform;

GRANT SELECT,INSERT ON TABLE login_attempts TO integr8_auth;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE login_attempts TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE member_grants TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE member_grants TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE offline_grants TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE offline_grants TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE push_devices TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE push_devices TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE refresh_tokens TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE refresh_tokens TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE sessions TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sessions TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE tenant_roles TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_roles TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();

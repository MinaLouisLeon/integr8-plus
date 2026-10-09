-- Company branding, set by Integr8 for each company.
--
-- 0018 gave a company a logo and an accent colour that its own owner edited.
-- The product has since decided that look and feel are Integr8's to set per
-- company, like its forms and job types: the apps a company's people open are
-- built for that company and arrive already wearing its brand, and nobody in
-- the company changes the theme. These columns are the rest of what that
-- needs, beside `logo_media_id` and `brand_colour` which stay where they are.
--
--   shell_colour      the sidebar and top bar of the dashboard shell
--   default_theme     light, dark, or the device's own setting
--   website_url       the company's own site, shown in its phone app before
--                     sign-in and linked from the apps afterwards
--   app_icon_media_id a square image for the installer and phone icons, since
--                     a wide logo makes a poor one; falls back to Integr8's
--   apps_enabled      whether the release pipeline builds this company's own
--                     desktop installers and phone apps

alter table tenant_settings
  add column shell_colour      text,
  add column default_theme     text    not null default 'system',
  add column website_url       text,
  add column app_icon_media_id uuid,
  add column apps_enabled      boolean not null default false;

alter table tenant_settings
  add constraint tenant_settings_shell_colour_shape
    check (shell_colour is null or shell_colour ~ '^#[0-9A-Fa-f]{6}$'),
  add constraint tenant_settings_default_theme_known
    check (default_theme in ('light', 'dark', 'system')),
  -- https only, and bounded: it is handed to a web view on a phone.
  add constraint tenant_settings_website_url_shape
    check (website_url is null or (website_url ~ '^https://[^[:space:]]+$' and length(website_url) <= 2048)),
  -- The key carries the tenant, like the logo's, so a company cannot point its
  -- icon at another company's file. The schema invariants suite checks this.
  add constraint tenant_settings_app_icon_fk
    foreign key (tenant_id, app_icon_media_id) references files (tenant_id, id) on delete set null;

comment on column tenant_settings.shell_colour is
  'The dashboard shell (sidebar, top bar) colour, #RRGGBB. Null means the product default.';
comment on column tenant_settings.default_theme is
  'light | dark | system: the theme every app of this company opens in. People in the company do not choose.';
comment on column tenant_settings.website_url is
  'The company''s own website, https only. Shown in its phone app before sign-in.';
comment on column tenant_settings.app_icon_media_id is
  'A square image used as the installer and phone app icon. Falls back to Integr8''s when null.';
comment on column tenant_settings.apps_enabled is
  'Whether the release pipeline builds desktop installers and phone apps for this company.';

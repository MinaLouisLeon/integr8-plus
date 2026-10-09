-- Reverses 0022. The logo and accent colour from 0018 stay; only the shell,
-- theme, website, icon and build switch go.

alter table tenant_settings
  drop constraint tenant_settings_app_icon_fk,
  drop constraint tenant_settings_website_url_shape,
  drop constraint tenant_settings_default_theme_known,
  drop constraint tenant_settings_shell_colour_shape;

alter table tenant_settings
  drop column apps_enabled,
  drop column app_icon_media_id,
  drop column website_url,
  drop column default_theme,
  drop column shell_colour;

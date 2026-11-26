DROP INDEX tenant_users_one_store_reviewer;

ALTER TABLE tenant_users
    DROP COLUMN store_reviewer;

ALTER TABLE tenant_settings
    DROP CONSTRAINT tenant_settings_app_store_id_shape,
    DROP CONSTRAINT tenant_settings_play_track,
    DROP CONSTRAINT tenant_settings_phone_distribution,
    DROP COLUMN app_store_id,
    DROP COLUMN play_track,
    DROP COLUMN phone_distribution;

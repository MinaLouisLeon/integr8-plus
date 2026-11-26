-- 0023 — how each company's phone app reaches its people, and the store reviewer.
--
-- A company's phone app is either an APK that Integr8 staff send (as before),
-- or published in the company's own Google Play and App Store accounts. The
-- release pipeline reads these per company (`/v1/build/companies`) to choose
-- the build and where it is submitted; the phone app opens the store's page
-- when it is told to update.
--
-- Both stores review an app before it goes public, and the app only signs in
-- that company's people, so each store company gets one reviewer account,
-- made by Integr8 staff. It is a person in the company like any other except
-- that it holds no seat: the company should not pay for the stores' review.

ALTER TABLE tenant_settings
    ADD COLUMN phone_distribution text NOT NULL DEFAULT 'apk',
    -- Google Play's track for a store company: internal testers first, then everyone.
    ADD COLUMN play_track text NOT NULL DEFAULT 'internal',
    -- The App Store's number for the company's app record (App Store Connect → App Information → Apple ID).
    ADD COLUMN app_store_id text,
    ADD CONSTRAINT tenant_settings_phone_distribution CHECK (phone_distribution IN ('apk', 'stores')),
    ADD CONSTRAINT tenant_settings_play_track CHECK (play_track IN ('internal', 'production')),
    ADD CONSTRAINT tenant_settings_app_store_id_shape CHECK ((app_store_id IS NULL) OR (app_store_id ~ '^[0-9]{6,12}$'::text));

ALTER TABLE tenant_users
    ADD COLUMN store_reviewer boolean NOT NULL DEFAULT false;

-- One live reviewer per company: the seat exemption must not become a way to add free people.
CREATE UNIQUE INDEX tenant_users_one_store_reviewer
    ON tenant_users (tenant_id)
    WHERE store_reviewer AND deleted_at IS NULL;

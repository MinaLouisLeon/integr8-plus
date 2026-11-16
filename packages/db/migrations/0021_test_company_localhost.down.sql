DROP TRIGGER tenant_settings_local_only_for_test ON tenant_settings;
DROP FUNCTION tenant_settings_local_only_for_test();

-- Test companies' localhost addresses do not fit the older shapes.
UPDATE tenant_settings
SET website_url = NULL
WHERE website_url LIKE 'http://%';

UPDATE tenant_settings
SET document_link_pattern = NULL
WHERE document_link_pattern LIKE 'http://%';

ALTER TABLE tenant_settings
    DROP CONSTRAINT tenant_settings_website_url_shape,
    DROP CONSTRAINT tenant_settings_document_link_pattern_shape;

ALTER TABLE tenant_settings
    ADD CONSTRAINT tenant_settings_website_url_shape CHECK (((website_url IS NULL) OR ((website_url ~ '^https://[^[:space:]]+$'::text) AND (length(website_url) <= 2048)))),
    ADD CONSTRAINT tenant_settings_document_link_pattern_shape CHECK (((document_link_pattern IS NULL) OR ((document_link_pattern ~ '^https://[^\s/?#]+'::text) AND (POSITION(('{code}'::text) IN (document_link_pattern)) > 0) AND (char_length(document_link_pattern) <= 500))));

COMMENT ON COLUMN tenant_settings.website_url IS 'The company''s own website, https only. Shown in its phone app before sign-in.';
COMMENT ON COLUMN tenant_settings.document_link_pattern IS 'https address with {code} on the company website that document links open; null for Integr8''s /d/ page (0075).';

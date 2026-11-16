-- P43: a test company's website may run on the developer's own machine.
--
-- The developer MCP server points a test company's website and document links
-- at `http://localhost:<port>` or `http://127.0.0.1:<port>`, so a company
-- website being built can be opened from a test document's QR code. Every real
-- company keeps https. The API refuses localhost for a real company; the
-- trigger below is the backstop, as a check constraint cannot see
-- `tenants.is_test` (which cannot change after the company is created, 0077).

ALTER TABLE tenant_settings
    DROP CONSTRAINT tenant_settings_website_url_shape,
    DROP CONSTRAINT tenant_settings_document_link_pattern_shape;

ALTER TABLE tenant_settings
    ADD CONSTRAINT tenant_settings_website_url_shape CHECK (
        website_url IS NULL
        OR (
            (website_url ~ '^https://[^[:space:]]+$'
             OR website_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$')
            AND length(website_url) <= 2048
        )
    ),
    ADD CONSTRAINT tenant_settings_document_link_pattern_shape CHECK (
        document_link_pattern IS NULL
        OR (
            (document_link_pattern ~ '^https://[^\s/?#]+'
             OR document_link_pattern ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?[/?#]')
            AND POSITION('{code}' IN document_link_pattern) > 0
            AND char_length(document_link_pattern) <= 500
        )
    );

CREATE FUNCTION tenant_settings_local_only_for_test() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
BEGIN
    IF (NEW.website_url LIKE 'http://%' OR NEW.document_link_pattern LIKE 'http://%')
       AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND is_test) THEN
        RAISE EXCEPTION 'only a test company may use a website on localhost'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_settings_local_only_for_test
    BEFORE INSERT OR UPDATE OF website_url, document_link_pattern ON tenant_settings
    FOR EACH ROW EXECUTE FUNCTION tenant_settings_local_only_for_test();

COMMENT ON COLUMN tenant_settings.website_url IS 'The company''s own website, https only (a test company may use http://localhost, 0021). Shown in its phone app before sign-in.';
COMMENT ON COLUMN tenant_settings.document_link_pattern IS 'https address with {code} on the company website that document links open (a test company may use http://localhost, 0021); null for Integr8''s /d/ page (0075).';

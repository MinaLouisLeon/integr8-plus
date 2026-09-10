import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig, requireAdminConnectionString } from './config.js';

const MINIMAL = { DATABASE_URL: 'postgres://integr8_app:pw@localhost:5432/integr8' };

describe('loadDatabaseConfig', () => {
  it('applies defaults for everything but the connection string', () => {
    const config = loadDatabaseConfig(MINIMAL);

    expect(config.DATABASE_URL).toBe(MINIMAL.DATABASE_URL);
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.DB_TENANT_CACHE_MAX).toBe(200);
    expect(config.DATABASE_URL_ADMIN).toBeUndefined();
  });

  it('names the missing variable rather than failing somewhere later', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL/u);
  });

  it('rejects a connection string that is not Postgres', () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: 'mysql://localhost/integr8' })).toThrow(
      /postgres/u,
    );
  });

  it('rejects a pool size that is not a positive integer', () => {
    expect(() => loadDatabaseConfig({ ...MINIMAL, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/u);
    expect(() => loadDatabaseConfig({ ...MINIMAL, DB_POOL_MAX: 'lots' })).toThrow(/DB_POOL_MAX/u);
  });

  it('reports every problem at once', () => {
    const message = (() => {
      try {
        loadDatabaseConfig({ DB_POOL_MAX: '-1', DB_TENANT_CACHE_MAX: 'no' });
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
      return '';
    })();

    expect(message).toMatch(/DATABASE_URL/u);
    expect(message).toMatch(/DB_POOL_MAX/u);
    expect(message).toMatch(/DB_TENANT_CACHE_MAX/u);
  });
});

describe('requireAdminConnectionString', () => {
  it('returns the owner connection when set', () => {
    const config = loadDatabaseConfig({
      ...MINIMAL,
      DATABASE_URL_ADMIN: 'postgres://postgres:pw@localhost:5432/integr8',
    });

    expect(requireAdminConnectionString(config)).toContain('postgres://postgres');
  });

  it('explains what is missing when an app container tries to migrate', () => {
    expect(() => requireAdminConnectionString(loadDatabaseConfig(MINIMAL))).toThrow(
      /DATABASE_URL_ADMIN/u,
    );
  });
});

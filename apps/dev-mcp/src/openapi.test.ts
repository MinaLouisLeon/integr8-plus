import { describe, expect, it } from 'vitest';
import { checkRequest, matchPath, RouteIndex } from './openapi.js';

const routes = RouteIndex.load();

describe('the route index', () => {
  it('reads every route of the API, with who may call it', () => {
    expect(routes.routes.length).toBeGreaterThan(200);
    const create = routes.find({ operationId: 'startSubmission' });
    expect(create).toMatchObject({
      method: 'POST',
      path: '/v1/submissions',
      permission: 'submission.fill',
      idempotency: 'honoured',
      security: 'bearer',
    });
  });

  it('finds routes by words, best first, every word matching', () => {
    const found = routes.search('submit submission');
    expect(found[0]?.operationId).toBe('submitSubmission');
    expect(routes.search('submit nonsenseword')).toEqual([]);
  });

  it('finds a route by a concrete path', () => {
    const route = routes.find({
      method: 'post',
      path: '/v1/submissions/0b8e1f5a-4d6e-4c55-9b0a-2f3b4c5d6e7f/submit',
    });
    expect(route?.operationId).toBe('submitSubmission');
    expect(matchPath('/v1/forms/{formId}/draft/publish', '/v1/forms/abc/draft/publish')).toEqual({
      formId: 'abc',
    });
  });

  it('marks the platform routes open to a limited session', () => {
    expect(routes.find({ operationId: 'listTestOutbox' })?.platformScopes).toEqual([
      'full',
      'test_companies',
    ]);
    expect(routes.find({ operationId: 'onboardCompany' })?.platformScopes).toBeNull();
  });
});

describe('checking a request before it is sent', () => {
  const create = routes.find({ method: 'POST', path: '/v1/customers' })!;

  it('passes a request that fits', () => {
    expect(checkRequest(create, { path: '/v1/customers', body: { name: 'Acme' } })).toEqual([]);
  });

  it('names what is wrong with one that does not', () => {
    const problems = checkRequest(create, { path: '/v1/customers', body: { status: 'nope' } });
    expect(problems.map((problem) => problem.where)).toEqual(
      expect.arrayContaining(['body.name', 'body.status']),
    );
    const list = routes.find({ method: 'GET', path: '/v1/customers' })!;
    expect(checkRequest(list, { path: '/v1/customers', query: { colour: 'red' } })).toEqual([
      { where: 'query.colour', message: 'This route takes no such query parameter.' },
    ]);
  });
});

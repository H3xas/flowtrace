/**
 * The route matcher that `join`, `cover`, `trace` and `span` share: a literal caller segment
 * against a route parameter, a glob caller read segment by segment, and the refusal to pick
 * between two candidates of equal rank. The matcher tests build a route index in memory; the
 * verb tests extract the invented `reef-ledger` corpus and run the CLI over it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { buildRouteIndex, matchRoute, matchRouteDetailed } from '../lib/join.js';
import { copyFixture, runCli } from './helpers.js';

function routeIndex(templates) {
  return buildRouteIndex(
    templates.map((spec) => {
      const [verb, template] = spec.includes(' ') ? spec.split(' ') : ['GET', spec];
      return {
        repo: 'api',
        fact: { type: 'route', verb, template, controller: 'Api', action: template, file: 'Api.cs', line: 1 },
      };
    }),
  );
}

function outcome(index, template, options = {}, verb = 'GET', aliases = []) {
  const result = matchRouteDetailed(index, verb, template, aliases, options);
  if (!result) return null;
  if (result.ambiguous) return { ambiguous: result.candidates };
  return { key: result.route.key, match: result.match, ...(result.alias ? { alias: result.alias } : {}) };
}

test('Test evidence AC-3: a literal caller segment matches a route parameter, after an exact match', () => {
  const index = routeIndex(['users/me', 'users/{id}', 'users/me/{x}', 'users/{id}/orders']);
  assert.deepEqual(outcome(index, 'users/42'), { key: 'GET users/*', match: 'parameter' });
  assert.deepEqual(outcome(index, 'users/me'), { key: 'GET users/me', match: 'exact' });
  assert.deepEqual(outcome(index, 'users/me/orders'), { key: 'GET users/me/*', match: 'parameter' });
  assert.deepEqual(outcome(index, 'users/42/orders'), { key: 'GET users/*/orders', match: 'parameter' });
  assert.deepEqual(outcome(index, '/users/42?expand=true'), { key: 'GET users/*', match: 'parameter' });
});

test('Test evidence AC-3: a parameter match applies after a glob prefix strip, an alias rewrite and a suffix match', () => {
  const index = routeIndex(['inventory/v1/items/{itemId}', 'shop/v1/carts/{cartId}/lines']);
  const aliases = [{ from: 'catalog/v1', to: 'inventory/v1' }];
  assert.deepEqual(outcome(index, 'catalog/v1/items/lamp-3', {}, 'GET', aliases), {
    key: 'GET inventory/v1/items/*',
    match: 'alias',
    alias: { from: 'catalog/v1', to: 'inventory/v1' },
  });
  assert.deepEqual(outcome(index, 'v1/carts/c-9/lines'), { key: 'GET shop/v1/carts/*/lines', match: 'suffix' });
  assert.deepEqual(outcome(index, 'carts/c-9/lines', { glob: true }), { key: 'GET shop/v1/carts/*/lines', match: 'suffix' });
  assert.deepEqual(outcome(index, 'shop/v1/carts/c-9/lines', { glob: true }), {
    key: 'GET shop/v1/carts/*/lines',
    match: 'parameter',
  });
});

test('Test evidence AC-3: a caller segment that is an unread value never matches a literal route segment', () => {
  const index = routeIndex(['users/me/orders']);
  assert.equal(outcome(index, 'users/${userId}/orders'), null);
});

test('Test evidence AC-4: a trailing glob in suffix matching stays inside its segment', () => {
  const index = routeIndex(['api/drafts/my/count', 'api/drafts/my/count/total', 'api/drafts/{id}']);
  assert.deepEqual(outcome(index, 'drafts/my/count*', { glob: true }), { key: 'GET api/drafts/my/count', match: 'suffix' });
  assert.deepEqual(outcome(index, 'drafts/*', { glob: true }), { key: 'GET api/drafts/*', match: 'suffix' });
  const totalOnly = routeIndex(['api/drafts/my/count/total']);
  assert.equal(outcome(totalOnly, 'drafts/my/count*', { glob: true }), null);
});

test('Test evidence AC-5: a glob prefix keeps segment boundaries, and a caller without the option keeps the base rule', () => {
  const index = routeIndex(['api/users/{id}', 'api/users/{id}/orders/{orderId}']);
  assert.equal(outcome(index, 'api/users*', { glob: true }), null);
  assert.deepEqual(outcome(index, 'api/users*'), { key: 'GET api/users/*', match: 'prefix' });
  const deep = routeIndex(['api/users/{id}/orders']);
  assert.deepEqual(outcome(deep, 'api/users/**', { glob: true }), { key: 'GET api/users/*/orders', match: 'prefix' });
  const named = routeIndex(['api/users', 'api/users/{id}']);
  assert.deepEqual(outcome(named, 'api/users*', { glob: true }), { key: 'GET api/users', match: 'prefix' });
  assert.equal(matchRoute(index, 'GET', 'api/users*', [], { glob: true }), null);
  assert.equal(matchRoute(index, 'GET', 'api/users*').route.key, 'GET api/users/*');
});

test('Test evidence AC-6: equal candidates of a new tier give no route, and the detailed result names them', () => {
  const index = routeIndex(['shop/v1/carts/{cartId}/lines', 'depot/v1/carts/{binId}/lines']);
  assert.deepEqual(outcome(index, 'carts/c-9/lines'), {
    ambiguous: ['GET depot/v1/carts/*/lines', 'GET shop/v1/carts/*/lines'],
  });
  assert.equal(matchRoute(index, 'GET', 'carts/c-9/lines'), null);

  const verbs = routeIndex(['GET lamps/{id}', 'DELETE lamps/{id}']);
  assert.deepEqual(outcome(verbs, 'lamps/7', {}, 'ANY'), { ambiguous: ['DELETE lamps/*', 'GET lamps/*'] });
  assert.deepEqual(outcome(verbs, 'lamps/7', {}, 'DELETE'), { key: 'DELETE lamps/*', match: 'parameter' });

  const deep = routeIndex(['api/users/{id}', 'api/users/{id}/orders']);
  assert.deepEqual(outcome(deep, 'api/users/**', { glob: true }), {
    ambiguous: ['GET api/users/*', 'GET api/users/*/orders'],
  });
});

test('Test evidence AC-6: a caller the base tiers matched keeps its route and its kind', () => {
  const index = routeIndex([
    'orders/v1/checkout',
    'orders/v1/items/{id}',
    'inventory/v1/items',
    'shop/v1/cart/items/{id}',
    'reports/v1/daily',
    'reports/v1/weekly',
  ]);
  const aliases = [{ from: 'catalog/v1', to: 'inventory/v1' }];
  const cases = [
    ['orders/v1/checkout', 'GET orders/v1/checkout', 'exact'],
    ['/orders/v1/items/${itemId}', 'GET orders/v1/items/*', 'exact'],
    ['orders/v1/${rest}', 'GET orders/v1/checkout', 'prefix'],
    ['reports/v1/${kind}', 'GET reports/v1/daily', 'prefix'],
    ['catalog/v1/items', 'GET inventory/v1/items', 'alias'],
    ['cart/items/${id}', 'GET shop/v1/cart/items/*', 'suffix'],
  ];
  for (const [template, key, match] of cases) {
    const found = matchRoute(index, 'GET', template, aliases);
    assert.equal(found && found.route.key, key, template);
    assert.equal(found.match, match, template);
    assert.equal(matchRoute(index, 'GET', template, aliases.map((alias) => ({ ...alias }))).route.key, key, template);
  }
});

test('Test evidence AC-7: trace, span and component-span reach a parameter route from a gateway call with a literal segment', (t) => {
  const dir = copyFixture(t, 'reef-ledger');
  const config = ['--config', 'reef.config.json'];
  assert.equal(runCli(['extract', ...config], { cwd: dir }).status, 0);

  const traced = runCli(['trace', 'GuideLogsPanel', '--json', ...config], { cwd: dir });
  assert.equal(traced.status, 0, traced.stderr);
  const routes = JSON.parse(traced.stdout)
    .nodes.filter((node) => node.kind === 'route')
    .map((node) => ({ ref: node.ref, via: node.via, unresolved: node.unresolved === true }));
  assert.deepEqual(routes, [{ ref: 'GET reef/v1/divers/*/logs', via: 'parameter', unresolved: false }]);

  const page = joinPath(dir, 'logs.html');
  const spanned = runCli(['span', 'GET reef/v1/divers/*/logs', '--out', page, ...config], { cwd: dir });
  assert.equal(spanned.status, 0, spanned.stderr);
  const html = readFileSync(page, 'utf8');
  assert.match(html, /web › httpClient\.loadGuideLogs/);
  assert.match(html, /literal url · parameter match/);

  const component = runCli(['span', '--from-component', 'GuideLogsPanel', '--json', ...config], { cwd: dir });
  assert.equal(component.status, 0, component.stderr);
  const model = JSON.parse(component.stdout);
  assert.deepEqual(
    model.routes.map((route) => ({ key: route.key, via: route.arms.map((arm) => arm.via) })),
    [{ key: 'GET reef/v1/divers/*/logs', via: ['parameter'] }],
  );
});

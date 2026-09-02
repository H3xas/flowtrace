/**
 * Route-key normalisation shared by every extractor and by the join step.
 *
 * A route key is `${VERB} ${normalizedRoute}` and is the only value both sides of an
 * HTTP hop are expected to agree on.
 */

const TEMPLATE_EXPRESSION = /\$\{[^}]*\}/g;
const CURLY_PARAMETER = /\{[^{}]*\}/g;

const KNOWN_VERBS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'ANY',
]);

/**
 * Turn a route template from either side of the system into a comparable path.
 *
 * Query strings and fragments are dropped, template expressions and route parameters
 * become `*`, duplicate separators collapse, and the result is lower-cased with no
 * leading or trailing slash. Version segments are never collapsed.
 */
export function normalizeRoute(template) {
  if (template === undefined || template === null) return '';
  let route = String(template).trim();
  route = route.replace(TEMPLATE_EXPRESSION, '*');
  route = route.split('#')[0];
  route = route.split('?')[0];
  route = route.replace(CURLY_PARAMETER, '*');
  route = route.replace(/\*+/g, '*');
  route = route.replace(/\/{2,}/g, '/');
  route = route.replace(/^\/+/, '').replace(/\/+$/, '');
  return route.toLowerCase();
}

/**
 * Upper-case a request verb, falling back to `ANY` when it is missing or not a verb
 * this tool knows how to compare.
 */
export function normalizeVerb(verb) {
  if (typeof verb !== 'string') return 'ANY';
  const upper = verb.trim().toUpperCase();
  if (!upper) return 'ANY';
  return KNOWN_VERBS.has(upper) ? upper : 'ANY';
}

/** `${VERB} ${normalizeRoute(template)}` — the join key for every HTTP hop. */
export function routeKey(verb, template) {
  return `${normalizeVerb(verb)} ${normalizeRoute(template)}`;
}

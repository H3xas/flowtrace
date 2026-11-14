/**
 * The Cypress source reading that the `web` and `mobile` readers share, so one
 * `cy.intercept(...)` reads the same way in both suites.
 */

import { fullLiteral } from './text.js';

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** The verb and URL pattern one `cy.intercept(...)` argument list names. */
export function parseIntercept(parts) {
  const first = parts[0] ? parts[0].text.trim() : '';
  const firstLiteral = fullLiteral(first);
  if (firstLiteral !== null && HTTP_VERBS.has(firstLiteral.toUpperCase()) && parts.length > 1) {
    const second = parts[1].text.trim();
    const secondLiteral = fullLiteral(second);
    return { verb: firstLiteral.toUpperCase(), pattern: secondLiteral !== null ? secondLiteral : second };
  }
  if (firstLiteral !== null) return { verb: 'ANY', pattern: firstLiteral };
  const asRegExp = /^\/(.+)\/[a-z]*$/.exec(first);
  if (asRegExp) return { verb: 'ANY', pattern: asRegExp[1] };
  if (first.startsWith('{')) {
    const method = /method\s*:\s*(['"`])(\w+)\1/.exec(first);
    const url = /url\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(first);
    if (method || url) {
      return { verb: method ? method[2].toUpperCase() : 'ANY', pattern: url ? url[2] : first };
    }
  }
  return { verb: 'ANY', pattern: first || '*' };
}

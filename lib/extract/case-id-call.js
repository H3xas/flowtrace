/**
 * Argument positions of a configured case-id call (`caseId.calls`).
 *
 * The same callee can appear in two places: in title position, as a wrapper around the
 * title (`test(wrap(9001, 'refunds a sale'), fn)`), and inside a test body. In both the case
 * id is the first argument, and a wrapper's title is its second. The id reader and the title
 * check both read those positions from here, so the two can never disagree on which argument
 * is the id and which is the title — reading title text as an id would invent a link.
 *
 * Nothing here evaluates an expression or knows a callee name: the names come from
 * configuration and every answer is a slice of the source text.
 */

import { matchBalanced, splitArgs } from './text.js';

/** The longest an unresolved argument is stated, the same cut `pw_test.test` takes. */
export const EXPRESSION_LIMIT = 160;

/**
 * `{ name, args }` when the whole of `text` is one call to an entry of `calls`, else `null`.
 * The text must start with the entry and end at the parenthesis that closes it: a call that is
 * one operand of a longer expression, a member of another object, or a text cut before its
 * closing parenthesis is not that call.
 */
export function configuredCall(text, calls) {
  const trimmed = String(text ?? '').trim();
  for (const entry of Array.isArray(calls) ? calls : []) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name === '' || !trimmed.startsWith(name)) continue;
    let open = name.length;
    while (open < trimmed.length && /\s/.test(trimmed[open])) open += 1;
    if (trimmed[open] !== '(') continue;
    if (matchBalanced(trimmed, open) !== trimmed.length - 1) continue;
    return { name, args: splitArgs(trimmed.slice(open + 1, -1)).map((part) => part.text) };
  }
  return null;
}

/**
 * The case-id argument text, or `null` when the call has none. A wrapper with one argument
 * holds a title and no id, so title position needs two; a body call needs one.
 */
export function caseIdArgument(call, position) {
  if (!call) return null;
  const needed = position === 'title' ? 2 : 1;
  return call.args.length >= needed ? call.args[0] : null;
}

/** The title argument text of a wrapper: its second argument, or its only one. */
export function titleArgument(call) {
  if (!call || call.args.length === 0) return null;
  return call.args.length >= 2 ? call.args[1] : call.args[0];
}

/** An argument stated on one line, cut so a long expression cannot bloat a fact. */
export function unresolvedExpression(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, EXPRESSION_LIMIT);
}

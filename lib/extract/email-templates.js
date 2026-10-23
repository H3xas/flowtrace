/**
 * Email template reader for a repository of kind `email-templates`: one `email_template` fact
 * for each JSON file its `templates.files` globs match, with the id and subject its selectors
 * read. A subject keeps its text with each `{{…}}` and `{{{…}}}` placeholder as `*`, so a read
 * pattern can be matched against it.
 */

import { readFileSync } from 'node:fs';

import { parseSelector } from '../config.js';
import { fact } from '../facts.js';
import { walk } from '../walk.js';
import { toRelative } from './text.js';

const DEFAULT_EXCLUDE = ['node_modules', 'dist'];

/** The one value `selector` picks in `document`, or the reason it picks none. */
export function selectValue(document, selector) {
  let node = document;
  for (const { key, filter } of selector) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, key)) return { reason: 'no-element' };
    node = node[key];
    if (!filter) continue;
    if (!Array.isArray(node)) return { reason: 'no-element' };
    const matches = node.filter((entry) => entry && typeof entry === 'object' && String(entry[filter.field]) === filter.value);
    if (matches.length === 0) return { reason: 'no-element' };
    if (matches.length > 1) return { reason: 'two-elements' };
    node = matches[0];
  }
  return typeof node === 'string' ? { value: node } : { reason: 'not-a-string' };
}

// A `templates.files` glob as a regular expression over a `/`-separated path relative to the
// repository root: `*` and `?` match inside one segment, `**/` matches zero or more whole
// directories, and another `**` matches text across segments. The exclusion globs of `walk`
// and `affected` read `**` their own way, so this one is the template reader's own.
export function templateGlob(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') {
        source += '(?:.*/)?';
        index += 1;
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}

function subjectGlob(text) {
  return text.replace(/\{\{\{[^{}]*\}\}\}/g, '*').replace(/\{\{[^{}]*\}\}/g, '*');
}

/** The line of the first place `value` appears as a JSON string in `text`, else 1. */
function lineOfValue(text, value) {
  const at = text.indexOf(JSON.stringify(value));
  return at === -1 ? 1 : text.slice(0, at).split('\n').length;
}

export function extract(root, options = {}) {
  const templates = options.templates;
  if (!templates) return [];
  const globs = templates.files.map((glob) => templateGlob(glob.replace(/^\.\//, '')));
  const idSelector = parseSelector(templates.id);
  const subjectSelector = parseSelector(templates.subject);
  const exclude = [...DEFAULT_EXCLUDE, ...(Array.isArray(options.exclude) ? options.exclude : [])];
  const facts = [];
  for (const absPath of walk(root, { extensions: ['.json'], exclude })) {
    const rel = toRelative(root, absPath);
    if (!globs.some((glob) => glob.test(rel))) continue;
    let text;
    let document;
    try {
      text = readFileSync(absPath, 'utf8');
      document = JSON.parse(text);
    } catch {
      facts.push(fact('email_template', { file: rel, line: 1, id: null, subject: null, reason: 'unread-file' }));
      continue;
    }
    const id = selectValue(document, idSelector);
    const subject = selectValue(document, subjectSelector);
    const reasons = [...(id.reason ? [`id-${id.reason}`] : []), ...(subject.reason ? [`subject-${subject.reason}`] : [])];
    facts.push(
      fact('email_template', {
        file: rel,
        line: subject.value !== undefined ? lineOfValue(text, subject.value) : 1,
        id: id.value ?? null,
        subject: subject.value !== undefined ? subjectGlob(subject.value) : null,
        ...(reasons.length > 0 ? { reason: reasons.join(' ') } : {}),
      }),
    );
  }
  return facts;
}

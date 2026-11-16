/**
 * Synchronous source-tree walker.
 *
 * Returns sorted absolute paths for every file under `root` whose name ends with one of
 * `extensions`. Build and metadata directories are always skipped; `exclude` entries are
 * matched against the repository-relative path as plain substrings, as whole path
 * segments, or as glob-ish patterns when they contain `*` or `?`.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist']);

function toExtensionMatcher(extensions) {
  if (extensions === undefined || extensions === null) return null;
  const list = extensions instanceof Set ? [...extensions] : [].concat(extensions);
  const suffixes = list
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => {
      const trimmed = value.trim().toLowerCase();
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    });
  if (suffixes.length === 0) return null;
  return (name) => {
    const lower = name.toLowerCase();
    return suffixes.some((suffix) => lower.endsWith(suffix));
  };
}

function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function toPatterns(exclude) {
  const list = exclude instanceof Set ? [...exclude] : [].concat(exclude ?? []);
  return list
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((value) => value !== '')
    .map((value) =>
      value.includes('*') || value.includes('?')
        ? { glob: globToRegExp(value) }
        : { text: value },
    );
}

function isExcluded(relativePath, patterns) {
  if (patterns.length === 0) return false;
  const segments = relativePath.split('/');
  return patterns.some((pattern) => {
    if (pattern.glob) {
      return pattern.glob.test(relativePath) || segments.some((segment) => pattern.glob.test(segment));
    }
    return relativePath.includes(pattern.text) || segments.includes(pattern.text);
  });
}

function visit(directory, prefix, context) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (isExcluded(relativePath, context.patterns)) continue;
      visit(join(directory, entry.name), relativePath, context);
      continue;
    }
    if (!entry.isFile()) continue;
    if (context.matches && !context.matches(entry.name)) continue;
    if (isExcluded(relativePath, context.patterns)) continue;
    context.found.push(join(directory, entry.name));
  }
}

export function walk(root, { extensions, exclude = [] } = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('walk: root must be a non-empty path');
  }
  const absoluteRoot = resolve(root);
  let stats;
  try {
    stats = statSync(absoluteRoot);
  } catch {
    throw new Error(`walk: root does not exist: ${absoluteRoot}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`walk: root is not a directory: ${absoluteRoot}`);
  }
  const context = {
    found: [],
    patterns: toPatterns(exclude),
    matches: toExtensionMatcher(extensions),
  };
  visit(absoluteRoot, '', context);
  return context.found.sort();
}

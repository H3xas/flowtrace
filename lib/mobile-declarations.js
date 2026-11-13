/**
 * Declaration identity for mobile traversal.
 *
 * A mobile dependency fact names the local spelling of a type, and many repositories
 * declare two classes under one name in different files. This module answers one question
 * from the extracted facts alone: which declaration file a dependency or template owner
 * names. It never reads source or the filesystem, so a saved snapshot resolves exactly as
 * it did when the extractor wrote it.
 *
 * A resolved identity is repository, declaration file and class name. Every refusal is the
 * one public catch-all `mobile-declaration-unresolved`, with the sorted candidate files
 * when more than one declaration could be meant. A refusal never falls back to another
 * declaration that happens to share the name.
 */

import { posix } from 'node:path';

/** The one refusal reason a mobile declaration site states. */
export const MOBILE_DECLARATION_UNRESOLVED = 'mobile-declaration-unresolved';

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Every mobile declaration one fact set states, indexed by file and by name. `exports` is
 * the declaration's own named value export list as the extractor proved it; a declaration
 * that states the field at all and lists nothing is a proven private declaration, and one
 * that states no field is legacy metadata that proves nothing.
 */
export function mobileDeclarationIndex(factSets) {
  const byFile = new Map();
  const byName = new Map();
  for (const set of factSets || []) {
    const repo = set.repo;
    for (const fact of set.facts || []) {
      if (fact.type !== 'component') continue;
      const declaration = {
        repo,
        file: fact.file,
        name: fact.name,
        role: fact.role,
        line: fact.line,
        exports: Array.isArray(fact.exports) ? fact.exports.slice() : undefined,
        exportsMalformed: fact.exports !== undefined && !Array.isArray(fact.exports),
      };
      const fileKey = `${repo}|${fact.file}`;
      const nameKey = `${repo}|${fact.name}`;
      const inFile = byFile.get(fileKey);
      if (inFile) inFile.push(declaration);
      else byFile.set(fileKey, [declaration]);
      const named = byName.get(nameKey);
      if (named) named.push(declaration);
      else byName.set(nameKey, [declaration]);
    }
  }
  return { byFile, byName };
}

/** The repository-relative `.ts` file a written specifier names, or null when it names none we may follow. */
export function declarationFileOf(callerFile, specifier) {
  if (!isNonEmptyString(specifier) || callerFile === undefined) return null;
  const written = specifier.trim();
  if (!written.startsWith('./') && !written.startsWith('../')) return null;
  if (written.includes('\\') || written.endsWith('/')) return null;
  if (/\.d\.ts$/i.test(written)) return null;
  // Only a known source extension counts as one. A dotted basename such as
  // `./plot.service` is an extensionless specifier for `plot.service.ts`, not a file of
  // an unsupported extension.
  const extension = /\.(?:[cm]?[jt]sx?|json)$/i.exec(written);
  if (extension && extension[0].toLowerCase() !== '.ts') return null;
  const target = extension ? written : `${written}.ts`;
  const normalized = posix.normalize(posix.join(posix.dirname(callerFile), target));
  if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized === '' || normalized === '.') return null;
  return normalized;
}

function candidatesOf(declarations) {
  return [...new Set(declarations.map((declaration) => declaration.file))].sort();
}

function targetOf(declaration) {
  return {
    repo: declaration.repo,
    file: declaration.file,
    name: declaration.name,
    role: declaration.role,
    line: declaration.line,
  };
}

function refusal(declarations = []) {
  const candidates = candidatesOf(declarations);
  return { unresolved: MOBILE_DECLARATION_UNRESOLVED, ...(candidates.length > 0 ? { candidates } : {}) };
}

/**
 * The declaration an explicit or absent import names.
 *
 * An explicit import is the written `source` plus the `imported` named value export. It
 * binds only a declaration in exactly that file whose own export list proves the name, so
 * the class it enters can differ from the local alias. Nothing else may stand in: no other
 * extension, no directory index, no live source read, no same-named declaration elsewhere.
 *
 * With no import evidence at all, the legacy rule is bounded: a declaration written in the
 * caller's own file wins, then a single declaration in the repository. A duplicate without
 * file proof refuses.
 */
export function resolveMobileDependency(index, repo, callerFile, site) {
  if (!site || typeof site !== 'object') return refusal();
  const name = isNonEmptyString(site.name) ? site.name : '';
  if (own(site, 'unresolved')) return refusal();
  if (own(site, 'source') || own(site, 'imported')) {
    if (!isNonEmptyString(site.source) || !isNonEmptyString(site.imported)) return refusal();
    const file = declarationFileOf(callerFile, site.source);
    if (!file) return refusal();
    const declarations = index.byFile.get(`${repo}|${file}`) || [];
    if (declarations.some((declaration) => declaration.exportsMalformed)) return refusal(declarations);
    const proven = declarations.filter(
      (declaration) => Array.isArray(declaration.exports) && declaration.exports.includes(site.imported),
    );
    if (proven.length === 1) return { target: targetOf(proven[0]) };
    return refusal(proven.length > 1 ? proven : []);
  }
  if (!name) return refusal();
  const declaredInFile = (index.byFile.get(`${repo}|${callerFile}`) || []).filter(
    (declaration) => declaration.name === name,
  );
  if (declaredInFile.length === 1) return { target: targetOf(declaredInFile[0]) };
  if (declaredInFile.length > 1) return refusal(declaredInFile);
  const named = index.byName.get(`${repo}|${name}`) || [];
  if (named.length === 1) return { target: targetOf(named[0]) };
  return refusal(named);
}

/**
 * The declaration that owns a template fact. A stated `componentFile` must name a
 * declaration of the owner in exactly that file. Without it, a unique owner keeps the
 * legacy behavior, and a template written in the owner's own file proves the owner by
 * that file alone. A duplicate owner with no proof refuses rather than taking the one
 * read last.
 */
export function resolveMobileOwner(index, repo, ownerName, site) {
  const name = isNonEmptyString(ownerName) ? ownerName : '';
  if (!name) return refusal();
  if (own(site, 'componentFile')) {
    if (!isNonEmptyString(site.componentFile)) return refusal();
    const declarations = (index.byFile.get(`${repo}|${site.componentFile}`) || []).filter(
      (declaration) => declaration.name === name,
    );
    if (declarations.length === 1) return { target: targetOf(declarations[0]) };
    return refusal(declarations);
  }
  const named = index.byName.get(`${repo}|${name}`) || [];
  if (named.length === 1) return { target: targetOf(named[0]) };
  const declaredInFile = isNonEmptyString(site && site.file)
    ? named.filter((declaration) => declaration.file === site.file)
    : [];
  if (declaredInFile.length === 1) return { target: targetOf(declaredInFile[0]) };
  return refusal(named);
}

/** Whether a resolved target is the declaration a walk node already stands in. */
export function sameDeclaration(node, target) {
  return Boolean(
    node &&
      target &&
      node.repo === target.repo &&
      node.file === target.file &&
      (node.ref === target.name || node.class === target.name),
  );
}

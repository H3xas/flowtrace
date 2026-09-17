/**
 * What a `flowtrace-edges` document must satisfy on its own, with no checkout, no git and
 * no second document to compare against. Returns one message per violation, each naming
 * the field that is wrong, so a caller can fail on a non-empty list and say what moved.
 *
 * Deliberately independent of `lib/`: the id is re-derived here from the documented
 * formula, so an implementation that drifts from its own documentation fails instead of
 * agreeing with itself.
 */
import { createHash } from 'node:crypto';

/** sha1 of empty input: the `dirtyDigest` of a working tree with no changed paths. */
export const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

const SHA1 = /^[0-9a-f]{40}$/;

/** The documented `provenance.id`: sha1 over `[producer, formatVersion, factSets]`, 16 hex. */
export function deriveProvenanceId(provenance) {
  return createHash('sha1')
    .update(JSON.stringify([provenance.producer, provenance.formatVersion, provenance.factSets]))
    .digest('hex')
    .slice(0, 16);
}

function edgeName(edge, index) {
  return `edges[${index}] (${edge?.kind ?? 'no kind'} ${edge?.key ?? 'no key'})`;
}

function revisionProblems(set, at) {
  const problems = [];
  if (!Object.hasOwn(set, 'headSha')) {
    return [`${at}.headSha is absent; a fact-set identity states its revision witness, or null when it has none`];
  }
  if (set.headSha === null) {
    for (const field of ['dirty', 'dirtyDigest']) {
      if (Object.hasOwn(set, field)) problems.push(`${at}.${field} is stated for a fact set with no revision witness`);
    }
    return problems;
  }
  if (typeof set.headSha !== 'string' || !SHA1.test(set.headSha)) {
    problems.push(`${at}.headSha ${JSON.stringify(set.headSha)} is neither a commit sha nor null`);
  }
  if (typeof set.dirty !== 'boolean') {
    problems.push(`${at}.dirty ${JSON.stringify(set.dirty ?? null)} is not a boolean`);
  } else if (set.dirty === false && set.dirtyDigest !== EMPTY_SHA1) {
    problems.push(`${at}.dirtyDigest ${JSON.stringify(set.dirtyDigest ?? null)} is not the empty-tree digest a clean fact set carries`);
  } else if (set.dirty === true && (typeof set.dirtyDigest !== 'string' || !SHA1.test(set.dirtyDigest) || set.dirtyDigest === EMPTY_SHA1)) {
    problems.push(`${at}.dirtyDigest ${JSON.stringify(set.dirtyDigest ?? null)} names no changed paths for a fact set marked dirty`);
  }
  return problems;
}

export function exportProblems(document) {
  const problems = [];
  const provenance = document?.provenance;
  if (!provenance || typeof provenance !== 'object') return ['provenance block is absent'];
  const factSets = Array.isArray(provenance.factSets) ? provenance.factSets : [];
  if (!Array.isArray(provenance.factSets)) problems.push('provenance.factSets is not an array');

  const derived = deriveProvenanceId(provenance);
  if (provenance.id !== derived) {
    problems.push(`provenance.id ${JSON.stringify(provenance.id ?? null)} is not the digest of its own block (${derived})`);
  }

  const edges = Array.isArray(document.edges) ? document.edges : [];
  edges.forEach((edge, index) => {
    if (!Object.hasOwn(edge ?? {}, 'provenance')) {
      problems.push(`${edgeName(edge, index)}: provenance is absent`);
    } else if (edge.provenance !== provenance.id) {
      problems.push(`${edgeName(edge, index)}: provenance ${JSON.stringify(edge.provenance)} is not the envelope's id ${JSON.stringify(provenance.id ?? null)}`);
    }
  });

  for (const set of factSets) {
    const at = `provenance.factSets[${set?.repo ?? '?'}]`;
    problems.push(...revisionProblems(set ?? {}, at));
    if (set?.provider && Object.hasOwn(set.provider, 'source')) {
      problems.push(`${at}.provider.source is stated; a provider's location never enters a fact-set identity`);
    }
  }

  const named = new Set(edges.flatMap((edge) => [edge?.from?.repo, edge?.to?.repo]));
  const repos = new Set(factSets.map((set) => set?.repo));
  const without = provenance.factSetsWithoutEdges;
  if (!Array.isArray(without)) {
    problems.push('provenance.factSetsWithoutEdges is absent; every fact set must be named by an edge or listed there');
  } else {
    for (const repo of repos) {
      if (!named.has(repo) && !without.includes(repo)) {
        problems.push(`provenance.factSets[${repo}] contributes no edge and is not listed in factSetsWithoutEdges`);
      }
    }
    for (const repo of without) {
      if (!repos.has(repo)) problems.push(`provenance.factSetsWithoutEdges names ${JSON.stringify(repo)}, which is not a fact set`);
      else if (named.has(repo)) problems.push(`provenance.factSetsWithoutEdges lists ${JSON.stringify(repo)}, which an edge names`);
    }
  }
  return problems;
}

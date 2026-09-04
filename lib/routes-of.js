/**
 * Reverse reachability for fact-backed points. Resolution chooses one exact fact or
 * declaration, then reuses complete forward route walks to prove membership.
 */

import { buildEvidenceIndex, cover } from './cover.js';
import { normalizeRoute, routeKey } from './normalize.js';
import { buildTraceIndex, factProvenanceKey, trace } from './trace.js';

export const ROUTES_OF_SCHEMA_VERSION = 1;
export const ROUTE_EVIDENCE_NOTE =
  'route evidence is attached to the route and does not prove that the resolved point executed';

const literalField = (type, field, category, comparison, anchor) =>
  Object.freeze({ type, field, category, comparison, anchor });

/** The complete public registry of strings accepted by literal resolution. */
export const SEARCHABLE_LITERAL_FIELDS = Object.freeze([
  literalField('route', 'template', 'route-template', 'route', 'node'),
  literalField('gateway_call', 'template', 'route-template', 'route', 'edge'),
  literalField('method_call', 'calledMethod', 'method-call-target', 'exact', 'edge'),
  literalField('publish', 'message', 'message-key', 'exact', 'edge'),
  literalField('consume', 'message', 'message-key', 'exact', 'edge'),
  literalField('cypress_test', 'test', 'spec-evidence', 'exact', 'evidence'),
  literalField('pw_test', 'test', 'spec-evidence', 'exact', 'evidence'),
]);

const LITERAL_RULES = new Map(
  SEARCHABLE_LITERAL_FIELDS.map((entry) => [`${entry.type}|${entry.field}`, entry]),
);

function compare(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function normalizeFile(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectFacts(factSets) {
  const facts = [];
  for (const set of factSets || []) {
    for (const fact of set.facts || []) facts.push({ repo: set.repo, kind: set.kind, fact });
  }
  return facts.sort(
    (left, right) =>
      compare(left.repo, right.repo) ||
      compare(left.fact.file, right.fact.file) ||
      Number(left.fact.line) - Number(right.fact.line) ||
      compare(left.fact.type, right.fact.type),
  );
}

function candidateSort(left, right) {
  return (
    compare(left.repo, right.repo) ||
    compare(left.file, right.file) ||
    left.line - right.line ||
    compare(left.kind, right.kind) ||
    compare(left.ref, right.ref)
  );
}

function publicCandidate(candidate) {
  return {
    mode: candidate.mode,
    kind: candidate.kind,
    ref: candidate.ref,
    repo: candidate.repo,
    file: candidate.file,
    line: candidate.line,
  };
}

function declarationCandidate(repo, fact, mode) {
  const method = fact.type === 'effect_handler' ? fact.field : fact.method;
  return {
    mode,
    kind: 'method',
    ref: `${fact.class}.${method}`,
    repo,
    file: fact.file,
    line: fact.line,
    anchor: { kind: 'node', repo, class: fact.class, method, file: fact.file },
  };
}

function exactDeclarationCandidates(facts, input, repoFilter) {
  const match = /^(.*):([1-9][0-9]*)$/.exec(String(input || '').trim());
  if (!match) return [];
  const file = normalizeFile(match[1]);
  const line = Number(match[2]);
  const enclosing = [];
  for (const { repo, fact } of facts) {
    if (repoFilter && repo !== repoFilter) continue;
    if (normalizeFile(fact.file) !== file) continue;
    if (fact.type !== 'method_span' && fact.type !== 'effect_handler') continue;
    const endLine = Number(fact.endLine);
    if (line < fact.line || line > endLine) continue;
    enclosing.push({ repo, fact, width: endLine - fact.line });
  }
  if (enclosing.length === 0) return [];
  const narrowestByRepo = new Map();
  for (const entry of enclosing) {
    const current = narrowestByRepo.get(entry.repo);
    if (current === undefined || entry.width < current) narrowestByRepo.set(entry.repo, entry.width);
  }
  const candidates = enclosing
    .filter((entry) => entry.width === narrowestByRepo.get(entry.repo))
    .map(({ repo, fact }) => declarationCandidate(repo, fact, 'file'));
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.repo}|${candidate.file}|${candidate.line}|${candidate.ref}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort(candidateSort);
}

function symbolCandidates(facts, input, repoFilter) {
  const wanted = String(input || '').trim();
  const matches = [];
  const seen = new Set();
  for (const { repo, fact } of facts) {
    if (repoFilter && repo !== repoFilter) continue;
    if (fact.type !== 'method_span' && fact.type !== 'effect_handler') continue;
    const method = fact.type === 'effect_handler' ? fact.field : fact.method;
    if (wanted !== method && wanted !== `${fact.class}.${method}`) continue;
    const key = `${repo}|${fact.file}|${fact.line}|${fact.class}|${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(declarationCandidate(repo, fact, 'symbol'));
  }
  return matches.sort(candidateSort);
}

function valuesOf(fact, field) {
  const value = fact[field];
  return Array.isArray(value) ? value : [value];
}

function literalEquals(rule, candidate, input) {
  if (typeof candidate !== 'string') return false;
  if (rule.comparison === 'route') return normalizeRoute(candidate) === normalizeRoute(input);
  return candidate === input;
}

function literalCandidate(repo, fact, rule, value) {
  const base = {
    mode: 'literal',
    kind: rule.category,
    ref: `${fact.type}.${rule.field}=${JSON.stringify(value)}`,
    repo,
    file: fact.file,
    line: fact.line,
  };
  if (rule.anchor === 'node') {
    return {
      ...base,
      anchor: { kind: 'node', repo, nodeKind: 'route', file: fact.file, line: fact.line },
    };
  }
  if (rule.anchor === 'evidence') {
    return {
      ...base,
      anchor: {
        kind: 'evidence',
        repo,
        spec: fact.spec,
        test: fact.test,
        file: fact.file,
        line: fact.line,
        factType: fact.type,
      },
    };
  }
  return {
    ...base,
    anchor: { kind: 'edge', key: factProvenanceKey(repo, fact) },
  };
}

function literalCandidates(facts, input, repoFilter) {
  const wanted = String(input || '');
  const candidates = [];
  const seen = new Set();
  for (const { repo, fact } of facts) {
    if (repoFilter && repo !== repoFilter) continue;
    for (const [field, value] of Object.entries(fact)) {
      const rule = LITERAL_RULES.get(`${fact.type}|${field}`);
      if (!rule) continue;
      for (const item of valuesOf(fact, field)) {
        if (!literalEquals(rule, item, wanted)) continue;
        const candidate = literalCandidate(repo, fact, rule, item);
        const key = `${candidate.repo}|${candidate.file}|${candidate.line}|${candidate.ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates.sort(candidateSort);
}

function finishResolution(input, mode, tried, candidates) {
  if (candidates.length === 0) return { status: 'unresolved', input, mode, tried };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      input,
      mode,
      tried,
      candidates,
    };
  }
  return { status: 'resolved', input, mode, tried, candidate: candidates[0] };
}

/** Resolve in file:line, method-symbol, literal order unless a mode is forced. */
export function resolvePoint(factSets, input, options = {}) {
  const facts = collectFacts(factSets);
  const forced = options.mode;
  const resolvers = {
    file: () => exactDeclarationCandidates(facts, input, options.repo),
    symbol: () => symbolCandidates(facts, input, options.repo),
    literal: () => literalCandidates(facts, input, options.repo),
  };
  const order = forced ? [forced] : ['file', 'symbol', 'literal'];
  const tried = [];
  for (const mode of order) {
    tried.push(mode);
    const candidates = resolvers[mode]();
    if (candidates.length > 0) return finishResolution(input, mode, tried, candidates);
  }
  return finishResolution(input, forced || 'auto', tried, []);
}

function routeEntries(factSets) {
  return collectFacts(factSets)
    .filter(({ fact }) => fact.type === 'route')
    .map(({ repo, fact }) => ({ repo, fact, key: routeKey(fact.verb, fact.template) }))
    .sort(
      (left, right) =>
        compare(left.key, right.key) ||
        compare(left.repo, right.repo) ||
        compare(left.fact.file, right.fact.file) ||
        left.fact.line - right.fact.line,
    );
}

function nodeMatches(node, anchor) {
  if (anchor.nodeKind) {
    return (
      node.kind === anchor.nodeKind &&
      node.repo === anchor.repo &&
      normalizeFile(node.file) === normalizeFile(anchor.file) &&
      node.line === anchor.line
    );
  }
  const declarationNode =
    node.kind === 'method' ||
    node.kind === 'action' ||
    (node.kind === 'db' && (node.methods || []).includes(anchor.method));
  return (
    declarationNode &&
    node.repo === anchor.repo &&
    node.class === anchor.class &&
    (node.method === anchor.method || (node.kind === 'db' && (node.methods || []).includes(anchor.method))) &&
    normalizeFile(node.file) === normalizeFile(anchor.file)
  );
}

function parentIndex(walked) {
  const parents = new Map();
  for (const edge of walked.edges || []) parents.set(edge.to, edge);
  return parents;
}

function pathTo(walked, targetId) {
  const nodes = new Map((walked.nodes || []).map((node) => [node.id, node]));
  const parents = parentIndex(walked);
  const path = [];
  let current = nodes.get(targetId);
  while (current) {
    path.push(current);
    const edge = parents.get(current.id);
    current = edge ? nodes.get(edge.from) : null;
  }
  return path.reverse();
}

function hopOf(node) {
  const repo = node.repo === 'bus' ? node.homeRepo || node.repo : node.repo;
  if (!repo || !node.file || !Number.isInteger(node.line)) return null;
  return {
    repo,
    kind: node.kind,
    ref: node.ref,
    file: node.file,
    line: node.line,
    via: node.via,
  };
}

function nodeWitness(walked, node, candidate) {
  const hops = pathTo(walked, node.id).map(hopOf);
  if (!hops.every(Boolean)) return null;
  hops[hops.length - 1] = {
    repo: candidate.repo,
    kind: candidate.kind,
    ref: candidate.ref,
    file: candidate.file,
    line: candidate.line,
    via: node.via,
  };
  return hops;
}

function edgeWitness(walked, edge, candidate) {
  const nodes = new Map((walked.nodes || []).map((node) => [node.id, node]));
  const target = nodes.get(edge.to);
  if (!target) return null;
  const hops = pathTo(walked, target.id).map(hopOf);
  if (!hops.every(Boolean)) return null;
  hops[hops.length - 1] = {
    repo: candidate.repo,
    kind: candidate.kind,
    ref: candidate.ref,
    file: candidate.file,
    line: candidate.line,
    via: edge.via,
  };
  return hops;
}

function evidenceWitness(walked, candidate) {
  const root = hopOf(walked.root);
  if (!root) return null;
  return [
    root,
    {
      repo: candidate.repo,
      kind: candidate.kind,
      ref: candidate.ref,
      file: candidate.file,
      line: candidate.line,
      via: 'evidence',
    },
  ];
}

function witnessSignature(hops) {
  return hops
    .map((hop) => `${hop.repo}|${hop.file}|${hop.line}|${hop.kind}|${hop.ref}|${hop.via}`)
    .join('>');
}

function matchingWitnesses(walked, candidate, route, evidenceIndex) {
  const witnesses = [];
  let missingProvenance = false;
  const add = (witness) => {
    if (witness) witnesses.push(witness);
    else missingProvenance = true;
  };
  if (candidate.anchor.kind === 'node') {
    for (const node of walked.nodes || []) {
      if (!nodeMatches(node, candidate.anchor)) continue;
      add(nodeWitness(walked, node, candidate));
    }
  } else if (candidate.anchor.kind === 'edge') {
    for (const edge of walked.edges || []) {
      if (!(edge.evidence || []).some((entry) => entry.key === candidate.anchor.key)) continue;
      add(edgeWitness(walked, edge, candidate));
    }
  } else {
    const evidence = evidenceIndex.byRoute.get(route.key) || [];
    const matched = evidence.some(
      (entry) =>
        entry.repo === candidate.anchor.repo &&
        entry.spec === candidate.anchor.spec &&
        entry.test === candidate.anchor.test,
    );
    if (matched) add(evidenceWitness(walked, candidate));
  }

  const unique = new Map();
  for (const witness of witnesses.filter(Boolean)) unique.set(witnessSignature(witness), witness);
  return {
    missingProvenance,
    witnesses: [...unique.values()].sort(
      (left, right) =>
        left.length - right.length || compare(witnessSignature(left), witnessSignature(right)),
    ),
  };
}

function routeCoverage(factSets, route, walked, options) {
  const report = cover(factSets, {
    area: 'routes-of',
    keys: [route.key],
    aliases: options.aliases,
    traceOptions: { aliases: options.aliases, sinks: options.sinks, repos: options.repos },
    trace: () => walked,
  });
  const record = report.routes[0];
  return {
    state: record.state,
    levels: record.levels,
    parity: record.parity,
    evidence: record.evidence,
    seeds: record.seeds,
    always: record.always,
    seedsTruncated: record.seedsTruncated,
  };
}

function resolutionForOutput(resolution) {
  const base = {
    status: resolution.status,
    mode: resolution.mode,
    tried: resolution.tried,
  };
  if (resolution.candidate) base.candidate = publicCandidate(resolution.candidate);
  if (resolution.candidates) base.candidates = resolution.candidates.map(publicCandidate);
  return base;
}

/**
 * Return every entry route whose complete fact-only walk contains the resolved point.
 * A reached safety budget invalidates the whole result instead of returning a partial set.
 */
export function routesOf(factSets, input, options = {}) {
  const resolution = resolvePoint(factSets, input, { mode: options.mode, repo: options.repo });
  const base = {
    schemaVersion: ROUTES_OF_SCHEMA_VERSION,
    query: {
      input,
      requestedMode: options.mode || 'auto',
      ...(options.repo ? { repo: options.repo } : {}),
    },
    resolution: resolutionForOutput(resolution),
  };
  if (resolution.status !== 'resolved') {
    return { ...base, verdict: resolution.status };
  }

  const index = buildTraceIndex(factSets);
  const evidenceIndex = buildEvidenceIndex(factSets, { aliases: options.aliases });
  const walkedRoutes = [];
  const incomplete = [];
  for (const route of routeEntries(factSets)) {
    const walked = trace(factSets, null, {
      index,
      startNode: {
        repo: route.repo,
        kind: 'route',
        ref: route.key,
        file: route.fact.file,
        line: route.fact.line,
        route: route.fact,
      },
      exhaustive: true,
      maxNodes: options.maxNodes,
      seeds: true,
      aliases: options.aliases,
      sinks: options.sinks,
      repos: options.repos,
    });
    if (walked.error || walked.candidates || walked.stats?.complete !== true) {
      incomplete.push({
        key: route.key,
        repo: route.repo,
        file: route.fact.file,
        line: route.fact.line,
        reason: walked.error || (walked.candidates ? 'ambiguous forward start' : 'forward walk reached its node safety budget'),
      });
      continue;
    }
    walkedRoutes.push({ route, walked });
  }

  if (incomplete.length > 0) {
    return {
      ...base,
      verdict: 'incomplete',
      completeness: {
        complete: false,
        routesWalked: walkedRoutes.length,
        routesIncomplete: incomplete.length,
        reasons: incomplete,
      },
    };
  }

  const matches = [];
  const witnessIncomplete = [];
  for (const { route, walked } of walkedRoutes) {
    const { witnesses, missingProvenance } = matchingWitnesses(
      walked,
      resolution.candidate,
      route,
      evidenceIndex,
    );
    if (missingProvenance) {
      witnessIncomplete.push({
        key: route.key,
        repo: route.repo,
        file: route.fact.file,
        line: route.fact.line,
        reason: 'a matching path lacks repository-relative provenance',
      });
      continue;
    }
    if (witnesses.length === 0) continue;
    matches.push({
      key: route.key,
      repo: route.repo,
      file: route.fact.file,
      line: route.fact.line,
      witness: {
        hops: witnesses[0],
        additionalPaths: witnesses.length - 1,
      },
      coverage: routeCoverage(factSets, route, walked, options),
    });
  }

  if (witnessIncomplete.length > 0) {
    return {
      ...base,
      verdict: 'incomplete',
      completeness: {
        complete: false,
        routesWalked: walkedRoutes.length,
        routesIncomplete: witnessIncomplete.length,
        reasons: witnessIncomplete,
      },
    };
  }

  return {
    ...base,
    verdict: matches.length > 0 ? 'routes' : 'empty',
    completeness: {
      complete: true,
      routesWalked: walkedRoutes.length,
      routesIncomplete: 0,
    },
    routes: matches,
    routeCount: matches.length,
    note: ROUTE_EVIDENCE_NOTE,
  };
}

function location(item) {
  return `${item.repo}:${item.file}:${item.line}`;
}

/** Human rendering of the same model emitted by `--json`. */
export function renderRoutesOf(report) {
  if (report.verdict === 'unresolved') {
    return `unresolved point ${JSON.stringify(report.query.input)} (tried ${report.resolution.tried.join(' -> ')})`;
  }
  if (report.verdict === 'ambiguous') {
    const lines = [
      `ambiguous point ${JSON.stringify(report.query.input)} (${report.resolution.candidates.length} candidates):`,
    ];
    for (const candidate of report.resolution.candidates) {
      lines.push(`  ${candidate.ref} — ${location(candidate)}`);
    }
    return lines.join('\n');
  }
  const candidate = report.resolution.candidate;
  if (report.verdict === 'incomplete') {
    const lines = [`resolved ${report.resolution.mode} ${candidate.ref} — ${location(candidate)}`, 'incomplete: no route set returned'];
    for (const reason of report.completeness.reasons) {
      lines.push(`  ${reason.key} — ${location(reason)} — ${reason.reason}`);
    }
    return lines.join('\n');
  }

  const lines = [
    `resolved ${report.resolution.mode} ${candidate.ref} — ${location(candidate)}`,
    report.verdict === 'empty'
      ? `routes: 0 (resolved but unreachable from ${report.completeness.routesWalked} entry routes)`
      : `routes: ${report.routeCount} (complete across ${report.completeness.routesWalked} entry routes)`,
  ];
  for (const route of report.routes) {
    lines.push('', `${route.key} — ${location(route)}`);
    const extra = route.witness.additionalPaths;
    lines.push(`  witness: shortest of ${extra + 1} path${extra === 0 ? '' : 's'}`);
    for (const hop of route.witness.hops) {
      lines.push(`    ${hop.via} ${hop.kind} ${hop.ref} — ${location(hop)}`);
    }
    lines.push(
      `  route evidence: ${route.coverage.state}; ${route.coverage.evidence.executing} executing, ${route.coverage.evidence.skipped} skipped`,
      `  evidence levels: route=${route.coverage.levels.route.state} · path=${route.coverage.levels.path.state} · disposition=${route.coverage.levels.disposition.state}`,
      `  parity: cypress=${route.coverage.parity.cypress} · playwright=${route.coverage.parity.playwright}`,
      `  seeds: ${route.coverage.seeds.length}${route.coverage.seedsTruncated ? ` (+${route.coverage.seedsTruncated} truncated)` : ''}`,
    );
    for (const entry of route.coverage.evidence.tests) {
      lines.push(`    evidence ${entry.label}${entry.skipped ? ' [skipped]' : ''} [${entry.match}]`);
    }
    for (const seed of route.coverage.seeds) {
      // The cover model spells a status outcome with its own arrow (`→ 400 BadRequest`);
      // sinks and reads do not, so the arrow is added only where none is present.
      const outcomes = [
        ...seed.sinks,
        ...(seed.reads > 0 ? [`reads ${seed.reads}`] : []),
        ...(seed.sinks.length === 0 && seed.response ? [seed.response] : []),
      ];
      const joined = outcomes.join(', ');
      const outcome = joined === '' ? '' : joined.startsWith('→') ? ` ${joined}` : ` → ${joined}`;
      lines.push(`    ${seed.id}${seed.key ? ` #${seed.key}` : ''} [${seed.state}/${seed.level}] ${seed.dispositions}${outcome}`);
      for (const evidence of seed.evidence) lines.push(`      evidence ${evidence}`);
      if (seed.evidenceMore > 0) lines.push(`      evidence +${seed.evidenceMore} more`);
    }
    for (const outcome of route.coverage.always) lines.push(`    always ${outcome}`);
  }
  lines.push('', `note: ${report.note}`);
  return lines.join('\n');
}

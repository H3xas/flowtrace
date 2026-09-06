/**
 * Render step — turns a joined flow graph into a mermaid subgraph for one endpoint,
 * or a whole-system markdown report, per the flowtrace contract.
 */

import { summarize } from './join.js';

const BACKWARD_DEPTH_CAP = 4;

function sanitizeId(raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_]/g, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

function nodeId(ref) {
  return sanitizeId(`${ref.repo}_${ref.ref}`);
}

function addNode(nodes, ref) {
  const id = nodeId(ref);
  if (!nodes.has(id)) nodes.set(id, ref.ref);
  return id;
}

function addEdgeLine(edgeLines, seen, fromId, toId, label) {
  const line = `  ${fromId} -->|${label}| ${toId}`;
  if (!seen.has(line)) {
    seen.add(line);
    edgeLines.push(line);
  }
}

function classKey(ref) {
  return ref.class || ref.ref;
}

/**
 * Walk `injects`/`renders` edges backwards from a calling service up to the page
 * that renders it, capped at BACKWARD_DEPTH_CAP hops. Returns the chain of edges in
 * outer-to-inner order (page-side edge first).
 */
function walkBackward(flow, startRef) {
  const path = [];
  let currentKey = classKey(startRef);
  let currentRole = startRef.role;
  let depth = 0;

  while (depth < BACKWARD_DEPTH_CAP) {
    if (currentRole === 'page') break;
    const parentEdge = flow.edges.find(
      (edge) => (edge.kind === 'injects' || edge.kind === 'renders') && edge.to.ref === currentKey
    );
    if (!parentEdge) break;
    path.unshift(parentEdge);
    currentKey = classKey(parentEdge.from);
    currentRole = parentEdge.from.role;
    depth += 1;
  }

  return path;
}

export function renderMermaid(flow, { endpoint }) {
  const nodes = new Map();
  const edgeLines = [];
  const seenEdges = new Set();

  const callEdges = flow.edges.filter((edge) => edge.kind === 'calls' && edge.key === endpoint);
  if (callEdges.length === 0) {
    return ['flowchart LR'].join('\n');
  }

  const routeRef = callEdges[0].to;
  const routeId = addNode(nodes, routeRef);

  for (const callEdge of callEdges) {
    const chainEdges = walkBackward(flow, callEdge.from);
    const pathRefs = chainEdges.map((edge) => edge.from).concat([callEdge.from]);

    let prevId = null;
    pathRefs.forEach((ref, index) => {
      const id = addNode(nodes, ref);
      if (prevId) addEdgeLine(edgeLines, seenEdges, prevId, id, chainEdges[index - 1].kind);
      prevId = id;
    });

    addEdgeLine(edgeLines, seenEdges, prevId, routeId, 'calls');
  }

  const publishEdges = flow.edges.filter(
    (edge) => edge.kind === 'publishes' && edge.from.file === routeRef.file
  );

  for (const publishEdge of publishEdges) {
    const messageId = addNode(nodes, publishEdge.to);
    addEdgeLine(edgeLines, seenEdges, routeId, messageId, 'publishes');

    const forwardEdges = flow.edges.filter(
      (edge) => (edge.kind === 'consumes' || edge.kind === 'enqueues') && edge.from.ref === publishEdge.to.ref
    );

    for (const forwardEdge of forwardEdges) {
      const targetId = addNode(nodes, forwardEdge.to);
      addEdgeLine(edgeLines, seenEdges, messageId, targetId, forwardEdge.kind);

      const pushEdges = flow.edges.filter(
        (edge) => edge.kind === 'pushes' && edge.from.file === forwardEdge.to.file
      );
      for (const pushEdge of pushEdges) {
        const pushId = addNode(nodes, pushEdge.to);
        addEdgeLine(edgeLines, seenEdges, targetId, pushId, 'pushes');
      }
    }
  }

  const lines = ['flowchart LR'];
  for (const [id, label] of nodes) {
    lines.push(`  ${id}["${label}"]`);
  }
  lines.push(...edgeLines);
  return lines.join('\n');
}

const COMPARISON_COLUMNS = ['extracted', 'external', 'agreed', 'disagreed', 'externalOnly', 'extractedOnly'];

/**
 * Who wrote the facts each later step rests on, from a `producerSummary`: one row per
 * producer per fact set, counted from the facts themselves, then — for a fact set whose
 * header carries a `provider` comparison — the per-type table of where the two sources
 * agreed, disagreed, or saw a site the other did not. An external tool is measured
 * against the extractor's baseline here, not trusted on its name.
 */
function renderProducers(producers) {
  const lines = ['## Fact producers', '', '| repo | producer | facts |', '|---|---|---|'];
  for (const set of producers) {
    lines.push(`| ${set.repo} | ${set.generatedFrom || 'extractor'} (extracted) | ${set.extracted} |`);
    for (const source of set.external) {
      const mode = set.provider && set.provider.producer === source.producer ? `, ${set.provider.merge}` : '';
      lines.push(`| ${set.repo} | ${source.producer}${source.version ? ` ${source.version}` : ''} (external${mode}) | ${source.facts} |`);
    }
  }
  for (const set of producers) {
    const provider = set.provider;
    if (!provider || !provider.comparison || Object.keys(provider.comparison).length === 0) continue;
    lines.push(
      '',
      `### ${set.repo}: extractor against ${provider.producer}${provider.version ? ` ${provider.version}` : ''} (${provider.merge})`,
      '',
      'Facts per source, then sites (type at one line): stated identically by both, stated differently, only by the provider, only by the extractor.',
      '',
      '| type | extracted | external | agreed | disagreed | provider only | extractor only |',
      '|---|---|---|---|---|---|---|',
    );
    for (const type of Object.keys(provider.comparison).sort()) {
      const row = provider.comparison[type];
      lines.push(`| ${type} | ${COMPARISON_COLUMNS.map((column) => row[column] ?? 0).join(' | ')} |`);
    }
  }
  return lines;
}

function formatUnjoinedRoute(entry) {
  return `- ${entry.key} — ${entry.fact.controller}.${entry.fact.action} (${entry.fact.file}:${entry.fact.line})`;
}

function formatUnjoinedCall(entry) {
  return `- ${entry.key} — ${entry.fact.service}.${entry.fact.method} (${entry.fact.file}:${entry.fact.line})`;
}

function formatUnresolvedPublish(entry) {
  return `- ${entry.repo}:${entry.fact.file}:${entry.fact.line} — ${entry.key}`;
}

/**
 * `options.generated`, when supplied, is stamped as `generated: <value>` right under
 * the title — a copy of the report can then be checked against a fresh run instead of
 * being trusted (or dismissed) on age alone. `bin/flowtrace.js` passes the flowtrace
 * version and an ISO timestamp; callers that only need the report body (tests, the
 * mermaid-only callers) can omit it.
 */
export function renderReport(flow, options = {}) {
  const counts = summarize(flow);
  const lines = [];

  lines.push('# Flowtrace Report', '');
  if (options.generated) {
    lines.push(`generated: ${options.generated}`, '');
  }

  lines.push('## Counts', '', '| item | count |', '|---|---|');
  for (const kind of Object.keys(counts.edges).sort()) {
    lines.push(`| edges:${kind} | ${counts.edges[kind]} |`);
  }
  lines.push(`| alias-matches | ${counts.aliasMatches} |`);
  for (const bucket of Object.keys(counts.unjoined).sort()) {
    lines.push(`| unjoined:${bucket} | ${counts.unjoined[bucket]} |`);
  }
  lines.push('');

  if (options.producers) {
    lines.push(...renderProducers(options.producers), '');
  }

  lines.push('## Routes with no mobile caller', '');
  if (flow.unjoined.routes_without_caller.length === 0) {
    lines.push('none');
  } else {
    for (const entry of flow.unjoined.routes_without_caller) lines.push(formatUnjoinedRoute(entry));
  }
  lines.push('');

  lines.push('## Mobile calls with no route', '');
  if (flow.unjoined.mobile_calls_without_route.length === 0) {
    lines.push('none');
  } else {
    for (const entry of flow.unjoined.mobile_calls_without_route) lines.push(formatUnjoinedCall(entry));
  }
  lines.push('');

  // Publish sites whose message type the extractor could not read: each names its reason,
  // so the reader knows whether a type annotation or a wider pattern would resolve it.
  lines.push('## Publishes whose message could not be resolved', '');
  const unresolvedPublishes = flow.unjoined.publish_unresolved ?? [];
  if (unresolvedPublishes.length === 0) {
    lines.push('none');
  } else {
    for (const entry of unresolvedPublishes) lines.push(formatUnresolvedPublish(entry));
  }
  lines.push('');

  lines.push('## Calls joined only through a gateway alias', '');
  const aliasEdges = flow.edges.filter((edge) => edge.kind === 'calls' && edge.match === 'alias');
  if (aliasEdges.length === 0) {
    lines.push('none');
  } else {
    for (const edge of aliasEdges) {
      lines.push(`- ${edge.callerKey} → ${edge.key} → ${edge.to.ref}`);
    }
  }
  lines.push('');

  const routeKeys = [...new Set(flow.edges.filter((edge) => edge.kind === 'calls').map((edge) => edge.key))].sort();
  const noCoverage = [];

  for (const key of routeKeys) {
    lines.push(`### ${key}`, '', '```mermaid', renderMermaid(flow, { endpoint: key }), '```', '', 'Covered by:');

    const testEdges = flow.edges.filter((edge) => edge.kind === 'tests' && edge.key === key);
    if (testEdges.length === 0) {
      lines.push('no Cypress coverage');
      noCoverage.push(key);
    } else {
      for (const edge of testEdges) lines.push(`- ${edge.from.file} :: ${edge.from.ref}`);
    }
    lines.push('');
  }

  lines.push('## Routes with callers but no Cypress coverage', '');
  if (noCoverage.length === 0) {
    lines.push('none');
  } else {
    for (const key of noCoverage) lines.push(`- ${key}`);
  }

  return lines.join('\n');
}

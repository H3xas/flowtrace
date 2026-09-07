/**
 * Assertion surface — where the state an entry route changes can be read back.
 *
 * `span` answers what must be true for a route and `cases` drafts how it would read. Neither
 * answers the question a spec author pays for by hand, once per outcome: **which endpoint
 * returns the thing this write changed**. This module derives that, and only that.
 *
 * The derivation is one walk in each direction, both of them over facts already on disk:
 *
 * - **Forward, to the state.** The route's own walk names the stores it writes — `ownersOf`
 *   for the synchronous leg, `messagesOf` for the processor consequences past every published
 *   message. Nothing here decides what a write is; it reads the same `access: 'write'` the
 *   span page prints, so a state on a surface and a "writes to" on the page are one claim.
 * - **Backward, to the endpoint.** From that store, every call site whose called method
 *   classifies as a **read** seeds a reverse walk up `method_call` receivers — resolved
 *   through `ctor_field` for the field's declared type and `di_binding` for the
 *   implementation behind an interface — until it reaches a class and method a `route` fact
 *   declares. A route answering a **safe verb** is an observation point; a route that would
 *   itself change state is not, and is carried only as the evidence behind a gap.
 *
 * Every hop on a surface is one fact with a `file:line` a reader can open, in the order the
 * state travels, so a surface is re-walked rather than trusted.
 *
 * **A broken chain is a row, never a guess.** Four things can stop the derivation and each
 * one emits a gap naming what stopped it and where: the walk reaches no write at all; a
 * written store has no read call site; its readers reach no route inside the hop budget; or
 * every route reading it is itself a write. A gap is never filled with the most plausible
 * endpoint, and a surface is never emitted from a name match — the same posture this tool
 * takes on case ids and on unresolved component arms. Resolving a correlation this walk
 * cannot prove is the cached-verdict half's job, not this one's.
 *
 * The output is a function of the fact sets alone: no index is consulted, no clock is read,
 * every list is sorted, so the same facts produce a byte-identical surface.
 */

import { messagesOf, ownersOf } from './span.js';
import { classifyAccess } from './trace.js';

/** The verbs an observation point may answer. Reading state must not change it. */
export const SAFE_VERBS = Object.freeze(['GET', 'HEAD']);

/** How many receiver hops a reader may be above the store before the chain is abandoned. */
export const DEFAULT_HOPS = 3;

/** How many evidence rows a gap names outright before folding the rest into a count. */
const EVIDENCE_CAP = 8;

/** Why a chain stopped, in the words the row prints. Exactly one per gap. */
export const GAP_REASONS = Object.freeze({
  'no-write': 'the route walk reaches no store write, so there is no changed state to read back',
  'no-reader': 'no call site reads this state, so nothing exposes what the write changed',
  'no-endpoint': 'the readers of this state reach no route inside the hop budget',
  'no-safe-endpoint': 'every route reading this state answers a state-changing verb, so none can observe the write',
});

function compare(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function byPlace(a, b) {
  return compare(a.file, b.file) || (a.line || 0) - (b.line || 0) || compare(a.ref, b.ref);
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Every type name a declared field could hold: the outer type, and each generic argument
 * inside it. Both are literally written at the declaration, so widening to them reads the
 * source rather than inferring past it — a candidate that is not really the receiver simply
 * fails to carry a matching method name later.
 */
export function typeCandidates(declared) {
  const text = String(declared || '').trim();
  if (text === '') return [];
  const names = new Set();
  const simple = (value) => {
    const trimmed = String(value || '').trim().replace(/\[\]$/, '').replace(/\?$/, '');
    if (trimmed === '') return '';
    const dot = trimmed.lastIndexOf('.');
    return dot === -1 ? trimmed : trimmed.slice(dot + 1);
  };
  const open = text.indexOf('<');
  if (open === -1) {
    const name = simple(text);
    if (name !== '') names.add(name);
    return [...names];
  }
  const outer = simple(text.slice(0, open));
  if (outer !== '') names.add(outer);
  const close = text.lastIndexOf('>');
  const inner = close > open ? text.slice(open + 1, close) : '';
  let depth = 0;
  let current = '';
  for (const character of `${inner},`) {
    if (character === '<') depth += 1;
    if (character === '>') depth -= 1;
    if (character === ',' && depth === 0) {
      for (const nested of typeCandidates(current)) names.add(nested);
      current = '';
      continue;
    }
    current += character;
  }
  return [...names];
}

/**
 * The receiver index the reverse walk runs on: what a field is declared as, what implements
 * an interface, who calls into a type, and which class and method a route declares. Built
 * once per derivation, keyed by repository so two repositories never join through a shared
 * class name.
 */
export function buildReceiverIndex(factSets) {
  const fieldType = new Map();
  const implsOf = new Map();
  const ifacesOf = new Map();
  const routeByAction = new Map();
  const calls = [];
  for (const set of factSets || []) {
    const repo = set.repo;
    for (const entry of set.facts || []) {
      if (entry.type === 'ctor_field') {
        // A field scoped to one handler by `method` is not the class's: its calls carry
        // `receiverType`, so the class-keyed lookup must not learn its type for siblings.
        if (entry.method === undefined) fieldType.set(`${repo}|${entry.class}|${entry.field}`, entry.paramType);
      } else if (entry.type === 'di_binding') {
        const iface = `${repo}|${entry.iface}`;
        const impl = `${repo}|${entry.impl}`;
        if (!implsOf.has(iface)) implsOf.set(iface, new Set());
        implsOf.get(iface).add(entry.impl);
        if (!ifacesOf.has(impl)) ifacesOf.set(impl, new Set());
        ifacesOf.get(impl).add(entry.iface);
      } else if (entry.type === 'route') {
        pushInto(routeByAction, `${repo}|${entry.controller}|${entry.action}`, entry);
      } else if (entry.type === 'method_call') {
        calls.push({ repo, fact: entry });
      }
    }
  }

  const index = { fieldType, implsOf, ifacesOf, routeByAction, callsInto: new Map(), callsIntoType: new Map() };
  for (const { repo, fact: entry } of calls) {
    for (const target of receiversOf(index, repo, entry.class, entry.field, entry.receiverType)) {
      const row = {
        repo,
        class: entry.class,
        method: entry.method,
        file: entry.file,
        line: entry.line,
        called: entry.calledMethod,
        target,
      };
      pushInto(index.callsInto, `${repo}|${target}|${entry.calledMethod}`, row);
      pushInto(index.callsIntoType, `${repo}|${target}`, row);
    }
  }
  for (const rows of index.callsInto.values()) rows.sort(byPlace);
  for (const rows of index.callsIntoType.values()) rows.sort(byPlace);
  return index;
}

/**
 * The types a `method_call` fact's receiver could be: the class itself for a self-call,
 * otherwise the declared type of the field it calls through plus every implementation
 * `di_binding` binds to it. A field the facts declare no type for resolves to nothing —
 * an unnamed receiver is absent, not assumed to be the class it sits in.
 *
 * `receiverType`, when the fact carries one, always wins over the `ctor_field` lookup: it is
 * the generic argument of a `GetRequiredService<T>()`/`GetService<T>()` service-locator
 * resolution, captured at the call site by the extractor rather than declared on a
 * constructor — the field it sits on (a local variable, or the locator field itself) was
 * never a `ctor_field` for `T` and never will be.
 */
export function receiversOf(index, repo, className, field, receiverType) {
  if (field === 'this') return [className];
  const declared = receiverType || index.fieldType.get(`${repo}|${className}|${field}`);
  if (!declared) return [];
  const names = new Set();
  for (const candidate of typeCandidates(declared)) {
    names.add(candidate);
    for (const impl of index.implsOf.get(`${repo}|${candidate}`) || []) names.add(impl);
  }
  return [...names].sort(compare);
}

function walkNodes(root, visit) {
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    visit(node);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
}

/**
 * Every store the route changes: the synchronous writes the endpoint owns, then the writes
 * a processor or consumer makes past each published message. Both readings are `span`'s
 * own, so this list and the span page's "writes to" lines never disagree.
 */
export function writesOf(result) {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const key = `${row.state}|${row.leg}|${row.through ? row.through.ref : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const store of ownersOf(result).repositories) {
    if (store.access !== 'write') continue;
    add({
      state: store.ref,
      repo: store.repo,
      file: store.file ?? null,
      line: store.line ?? null,
      methods: [...store.methods].sort(compare),
      leg: 'sync',
      through: null,
    });
  }
  for (const message of messagesOf(result)) {
    for (const answer of message.answeredBy) {
      for (const effect of answer.effects) {
        if (effect.kind !== 'db' || effect.words !== 'writes to') continue;
        add({
          state: effect.ref,
          repo: effect.repo,
          file: effect.file ?? null,
          line: effect.line ?? null,
          methods: [],
          leg: 'async',
          through: {
            message: message.message,
            kind: answer.kind,
            ref: answer.ref,
            file: answer.file ?? null,
            line: answer.line ?? null,
          },
        });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      compare(a.state, b.state) ||
      compare(a.leg, b.leg) ||
      compare(a.through ? a.through.ref : '', b.through ? b.through.ref : ''),
  );
}

/**
 * The references the walk could not follow, in file order. A route reaching no write at all
 * says nothing about why on its own; these rows are the `file:line` a reader opens to see
 * what stopped it — an interface with no binding, a receiver the index could not answer.
 *
 * A call on an interface-typed collection element that fanned out to zero known
 * implementations is named distinctly (`interface_fanout_empty`) rather than folded into the
 * plain `unresolved` a single-receiver interface with no binding gets — a reader should not
 * have to guess whether the gap is "no binding at all" or "fanned out, and there was nothing
 * to fan out to".
 */
export function unresolvedOf(result) {
  const rows = [];
  const seen = new Set();
  if (!result || !result.root) return rows;
  walkNodes(result.root, (node) => {
    const via =
      node.unresolved === true && node.fanout === 'interface'
        ? 'interface_fanout_empty'
        : node.unresolved === true
          ? 'unresolved'
          : node.graph === 'unavailable'
            ? 'index-unavailable'
            : null;
    if (!via) return;
    const row = { via, ref: node.ref ?? null, file: node.file ?? null, line: node.line ?? null };
    const key = `${row.via}|${row.ref}|${row.file}|${row.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });
  return rows.sort(byPlace);
}

function readSeeds(index, repo, state, accessPrefixes) {
  const names = new Set([state, ...(index.ifacesOf.get(`${repo}|${state}`) || [])]);
  const seeds = [];
  for (const name of [...names].sort(compare)) {
    for (const row of index.callsIntoType.get(`${repo}|${name}`) || []) {
      if (classifyAccess(row.called, accessPrefixes).access !== 'read') continue;
      seeds.push(row);
    }
  }
  return seeds.sort(byPlace);
}

/**
 * Reverse-walk one store to the routes that read it. Breadth first, so the chain a surface
 * carries is the shortest one the facts support; a class and method is entered once, and the
 * walk stops at every controller action rather than continuing through it.
 *
 * Returns `{ safe, unsafe, deepest }` — the safe-verb routes are observation points, the
 * rest are the evidence a `no-safe-endpoint` gap names, and `deepest` is the furthest reader
 * reached when nothing resolved at all.
 */
export function endpointsReading(index, repo, state, { hops = DEFAULT_HOPS, accessPrefixes = {} } = {}) {
  const seeds = readSeeds(index, repo, state, accessPrefixes);
  const safe = new Map();
  const unsafe = new Map();
  const visited = new Set();
  let deepest = null;
  const queue = seeds.map((row) => ({
    class: row.class,
    method: row.method,
    hop: 0,
    chain: [
      {
        via: 'read',
        ref: `${row.target}.${row.called}`,
        in: `${row.class}.${row.method}`,
        file: row.file,
        line: row.line,
      },
    ],
  }));
  while (queue.length > 0) {
    const current = queue.shift();
    const key = `${current.class}|${current.method}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (deepest === null || current.hop > deepest.hop) {
      deepest = { ref: `${current.class}.${current.method}`, hop: current.hop, chain: current.chain };
    }
    const routes = index.routeByAction.get(`${repo}|${current.class}|${current.method}`);
    if (routes && routes.length > 0) {
      for (const routeFact of [...routes].sort((a, b) => compare(a.template, b.template) || compare(a.verb, b.verb))) {
        const observe = `${routeFact.verb} ${routeFact.template}`;
        const bucket = SAFE_VERBS.includes(routeFact.verb) ? safe : unsafe;
        if (bucket.has(observe)) continue;
        bucket.set(observe, {
          observe,
          verb: routeFact.verb,
          template: routeFact.template,
          controller: routeFact.controller,
          action: routeFact.action,
          repo,
          file: routeFact.file,
          line: routeFact.line,
          hops: current.hop,
          chain: [...current.chain, { via: 'route', ref: observe, file: routeFact.file, line: routeFact.line }],
        });
      }
      continue;
    }
    if (current.hop >= hops) continue;
    const names = new Set([current.class, ...(index.ifacesOf.get(`${repo}|${current.class}`) || [])]);
    for (const name of [...names].sort(compare)) {
      for (const row of index.callsInto.get(`${repo}|${name}|${current.method}`) || []) {
        queue.push({
          class: row.class,
          method: row.method,
          hop: current.hop + 1,
          chain: [
            ...current.chain,
            {
              via: 'body',
              ref: `${current.class}.${current.method}`,
              in: `${row.class}.${row.method}`,
              file: row.file,
              line: row.line,
            },
          ],
        });
      }
    }
  }
  const order = (a, b) => a.hops - b.hops || compare(a.observe, b.observe);
  return { safe: [...safe.values()].sort(order), unsafe: [...unsafe.values()].sort(order), deepest };
}

function capped(rows) {
  return { rows: rows.slice(0, EVIDENCE_CAP), more: Math.max(0, rows.length - EVIDENCE_CAP) };
}

/**
 * One route's assertion surface: the states it changes, the safe-verb endpoints that read
 * each one back, and one gap row wherever that chain stopped.
 *
 * `result` is the route's walk — the caller passes the one it already has rather than
 * paying for a second. `options.hops` bounds the reverse walk, `options.sinks` supplies the
 * same read/write prefixes the walk itself classified store methods with.
 */
export function assertionSurface(factSets, routeKey, result, options = {}) {
  const sets = factSets || [];
  const hops = Number.isInteger(options.hops) && options.hops > 0 ? options.hops : DEFAULT_HOPS;
  const sinks = options.sinks || {};
  const accessPrefixes = {
    ...(sinks.writePrefixes ? { writePrefixes: sinks.writePrefixes } : {}),
    ...(sinks.readPrefixes ? { readPrefixes: sinks.readPrefixes } : {}),
  };
  const root = result && result.root ? result.root : null;
  const key = root && root.ref ? root.ref : routeKey;
  const route = {
    key,
    repo: root ? root.repo ?? null : null,
    controller: root && root.route ? root.route.controller ?? null : null,
    action: root && root.route ? root.route.action ?? null : null,
    file: root ? root.file ?? null : null,
    line: root ? root.line ?? null : null,
  };

  const states = result ? writesOf(result) : [];
  const index = buildReceiverIndex(sets);
  const surfaces = [];
  const gaps = [];

  if (states.length === 0) {
    const evidence = capped(unresolvedOf(result || {}));
    gaps.push({
      state: null,
      leg: null,
      through: null,
      reason: 'no-write',
      detail: GAP_REASONS['no-write'],
      file: route.file,
      line: route.line,
      evidence: evidence.rows,
      evidenceMore: evidence.more,
    });
  }

  for (const state of states) {
    const repo = state.repo || route.repo;
    const found = endpointsReading(index, repo, state.state, { hops, accessPrefixes });
    if (found.safe.length > 0) {
      for (const endpoint of found.safe) {
        surfaces.push({
          state: state.state,
          leg: state.leg,
          through: state.through,
          writes: state.methods,
          writeFile: state.file,
          writeLine: state.line,
          ...endpoint,
        });
      }
      continue;
    }
    const seeds = readSeeds(index, repo, state.state, accessPrefixes);
    const reason =
      seeds.length === 0 ? 'no-reader' : found.unsafe.length > 0 ? 'no-safe-endpoint' : 'no-endpoint';
    const evidence = capped(
      reason === 'no-safe-endpoint'
        ? found.unsafe.map((entry) => ({ via: 'route', ref: entry.observe, file: entry.file, line: entry.line }))
        : reason === 'no-endpoint' && found.deepest
          ? [{ via: 'reader', ref: found.deepest.ref, file: null, line: null }]
          : [],
    );
    gaps.push({
      state: state.state,
      leg: state.leg,
      through: state.through,
      reason,
      detail: GAP_REASONS[reason],
      file: state.file,
      line: state.line,
      evidence: evidence.rows,
      evidenceMore: evidence.more,
    });
  }

  surfaces.sort(
    (a, b) =>
      compare(a.state, b.state) ||
      compare(a.leg, b.leg) ||
      compare(a.through ? a.through.ref : '', b.through ? b.through.ref : '') ||
      a.hops - b.hops ||
      compare(a.observe, b.observe),
  );
  gaps.sort(
    (a, b) =>
      compare(a.state, b.state) ||
      compare(a.leg, b.leg) ||
      compare(a.through ? a.through.ref : '', b.through ? b.through.ref : '') ||
      compare(a.reason, b.reason),
  );

  return {
    route,
    states,
    surfaces,
    gaps,
    counts: {
      states: states.length,
      surfaces: surfaces.length,
      observed: new Set(surfaces.map((entry) => entry.state)).size,
      gaps: gaps.length,
    },
    limits: {
      hops,
      verbs: SAFE_VERBS.join(', '),
      carrier:
        'the hops between a store and a controller are the service methods the state travels through; the facts carry no return type, so no DTO is named and none is guessed',
      correlation:
        'a surface names an endpoint that reads the same state, never a claim that a particular response field reflects this write — that correlation is a cached verdict, not a walk',
      runtime: 'every hop is source-inferred; none is runtime-confirmed',
    },
  };
}

/**
 * The model as facts. One `assertion_surface` per resolved observation point, anchored at
 * the exposing route's own `file:line`, and one per gap, anchored at the write the chain
 * stopped past — or at the route itself when no write was reached. Nothing is emitted for a
 * chain that did not resolve except the gap that says so.
 */
export function surfaceFacts(model, factory) {
  const rows = [];
  for (const entry of model.surfaces) {
    rows.push(
      factory('assertion_surface', {
        file: entry.file,
        line: entry.line,
        route: model.route.key,
        status: 'resolved',
        chain: entry.chain,
        state: entry.state,
        leg: entry.leg,
        observe: entry.observe,
        verb: entry.verb,
        template: entry.template,
        controller: entry.controller,
        action: entry.action,
        hops: entry.hops,
        ...(entry.through ? { through: entry.through.ref, message: entry.through.message } : {}),
      }),
    );
  }
  for (const gap of model.gaps) {
    rows.push(
      factory('assertion_surface', {
        file: gap.file,
        line: gap.line,
        route: model.route.key,
        status: 'gap',
        chain: gap.evidence,
        reason: gap.reason,
        detail: gap.detail,
        ...(gap.state ? { state: gap.state } : {}),
        ...(gap.leg ? { leg: gap.leg } : {}),
        ...(gap.evidenceMore > 0 ? { evidenceMore: gap.evidenceMore } : {}),
        ...(gap.through ? { through: gap.through.ref, message: gap.through.message } : {}),
      }),
    );
  }
  return rows;
}

/** The terminal form: one block per state, its observation points, or the gap that replaced them. */
export function renderSurface(model, { cap = EVIDENCE_CAP } = {}) {
  const lines = [];
  const counts = model.counts;
  lines.push(
    `surface ${model.route.key}: ${counts.states} state${counts.states === 1 ? '' : 's'} written, ` +
      `${counts.observed} with a read surface, ${counts.gaps} gap${counts.gaps === 1 ? '' : 's'}`,
  );
  const stateKey = (row) => `${row.state}|${row.leg}|${row.through ? row.through.ref : ''}`;
  const byState = new Map();
  for (const entry of model.surfaces) {
    const key = stateKey(entry);
    if (!byState.has(key)) byState.set(key, []);
    byState.get(key).push(entry);
  }
  for (const state of model.states) {
    const key = stateKey(state);
    const wrote = state.methods.length > 0 ? `: ${state.methods.join(', ')}` : '';
    const through = state.through ? ` via ${state.through.ref} on ${state.through.message}` : '';
    lines.push(`  ${state.state} (${state.leg} write${wrote}${through})`);
    const found = byState.get(key) || [];
    for (const entry of found.slice(0, cap)) {
      const chain = [entry.chain[0].ref, ...entry.chain.filter((hop) => hop.in).map((hop) => hop.in)].join(' <- ');
      lines.push(`    ${entry.observe}  [${entry.hops} hop${entry.hops === 1 ? '' : 's'}]  ${chain}`);
    }
    if (found.length > cap) lines.push(`    +${found.length - cap} more`);
    for (const gap of model.gaps) {
      if (gap.state === null || stateKey(gap) !== key) continue;
      lines.push(`    gap (${gap.reason}) — ${gap.detail}`);
      for (const row of gap.evidence) lines.push(`      ${row.via}: ${row.ref}`);
      if (gap.evidenceMore > 0) lines.push(`      +${gap.evidenceMore} more`);
    }
  }
  for (const gap of model.gaps) {
    if (gap.state !== null) continue;
    lines.push(`  gap (${gap.reason}) — ${gap.detail}`);
    for (const row of gap.evidence) lines.push(`    ${row.via}: ${row.ref} (${row.file}:${row.line})`);
    if (gap.evidenceMore > 0) lines.push(`    +${gap.evidenceMore} more`);
  }
  lines.push(`  reverse walk bounded at ${model.limits.hops} hops; observation verbs: ${model.limits.verbs}`);
  lines.push(`  ${model.limits.correlation}`);
  return `${lines.join('\n')}\n`;
}

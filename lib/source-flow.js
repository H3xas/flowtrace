/**
 * The source-flow projection: the same walk the dependency view renders, read as the calls
 * of each body at their own call sites, in the order the source supports.
 *
 * The walk already knows which body calls which; the call records the walk kept say where in
 * that body each call was written, and the control evidence on the fact says what holds it.
 * This module turns those two into invocations and the constructs around them, and it fails
 * closed: a body whose facts cannot be placed becomes an unknown-order group that names the
 * reason and the sites, never an order the source did not state.
 *
 * The projection is the only place a source-flow answer is built. The terminal tree and the
 * `--html` page render from this object alone, and the same object is the `sourceFlow`
 * member of `--json`.
 */
import { createHash } from 'node:crypto';
import { factsDigest } from './facts.js';
import { CONTROL_EVIDENCE_VERSION, readControl } from './control-evidence.js';
import { internals } from './render-tree.js';

const { identityKey } = internals;

const CODE_BODY_KINDS = new Set(['method', 'action', 'page', 'component', 'class']);
const STOP_FOR_SKIP = Object.freeze({ recursion: 'cycle-guard', cycle: 'cycle-guard', unresolved: 'unresolved-target' });

function invocationId(parts) {
  return `inv-${createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

function siteOf(fact, repo) {
  return {
    repo,
    file: fact.file,
    line: fact.line,
    column: Number.isInteger(fact.column) ? fact.column : null,
  };
}

function declarationOf(node) {
  return { repo: node.repo, kind: node.kind, ref: node.ref, file: node.file ?? null, line: node.line ?? null };
}

function siteKey(site) {
  return site ? `${site.file}:${site.line}:${site.column ?? ''}` : '';
}

/** The reason a hop the walk made with no call fact behind it cannot be ordered. */
function hopReason(node) {
  if (node.via === 'graph') return 'code-index';
  if (node.kind === 'http_out') return 'http-out';
  if (node.kind === 'message') {
    if (node.worker) return 'worker';
    if (node.push) return 'push';
    if (node.consumer) return 'bus-consumer';
    return 'publish';
  }
  if (node.via === 'interface_fanout') return 'interface-fanout';
  if (node.via === 'unscoped') return 'unscoped';
  return 'independent-entries';
}

/** Whether a trailing invocation of this node is the same body the dependency view folds. */
function foldKey(node) {
  return identityKey(node);
}

/**
 * Build the source-flow projection for a finished walk. `result.callRecords` must be
 * present: the projection reads the call site of every invocation from it.
 */
export function sourceFlowOf(result, { factSets = [] } = {}) {
  const headers = new Map();
  const repoKinds = new Map();
  const digests = new Map();
  for (const set of factSets) {
    headers.set(set.repo, set.controlEvidence);
    repoKinds.set(set.repo, set.kind);
    digests.set(set.repo, factsDigest(set.facts || []));
  }
  const callRecords = result.callRecords instanceof Map ? result.callRecords : new Map();
  const nodeById = new Map((result.nodes || []).map((node) => [node.id, node]));
  if (result.root && !nodeById.has(result.root.id)) nodeById.set(result.root.id, result.root);

  const occurrences = occurrenceIndex(factSets);
  const shownBodies = new Map();
  const frontier = [];
  const counts = { bodies: 0, invocations: 0 };
  const activePath = new Map();
  const activeInvocations = new Map();

  const controlEvidence = {};
  for (const repo of [...headers.keys()].sort()) {
    controlEvidence[repo] = Number.isInteger(headers.get(repo)) ? headers.get(repo) : null;
  }

  function occurrenceOf(repo, fact) {
    const key = [repo, fact.file, fact.line, fact.column ?? null, fact.class || '', fact.method || '', fact.field || '', fact.calledMethod || fact.action || fact.service || ''].join('|');
    return occurrences.get(key) ?? 0;
  }

  function invocationFor(bodyNode, record, index) {
    const fact = record.fact;
    const repo = record.repo;
    const site = siteOf(fact, repo);
    const occurrence = occurrenceOf(repo, fact);
    const callerRepo = bodyNode.repo;
    const id = invocationId([
      (digests.get(callerRepo) || '').slice(0, 12),
      callerRepo,
      bodyNode.ref ?? '',
      repo,
      fact.file,
      fact.line,
      fact.column ?? null,
      occurrence + index,
    ]);
    return { id, site, occurrence };
  }

  function stopOf(record, node, declaration, invocation) {
    const stop = {
      reason: record.skipped ? STOP_FOR_SKIP[record.skipped] || 'unresolved-target' : node ? node.stop || 'unresolved-target' : 'unresolved-target',
      node: node ? node.id : null,
      site: siteOf(record.fact, record.repo),
      invocation,
      declaration,
    };
    frontier.push(stop);
    return stop.reason;
  }

  /** The code body a wrapper node stands for, when it wraps exactly one. */
  function descend(node) {
    let current = node;
    const seen = new Set([current.id]);
    while (!callRecords.has(current.id) && (current.children || []).length === 1) {
      const child = current.children[0];
      if (!CODE_BODY_KINDS.has(child.kind) || child.via === 'graph' || seen.has(child.id)) break;
      seen.add(child.id);
      current = child;
    }
    return current;
  }

  function targetOf(record, bodyNode) {
    const nodes = (record.nodes || []).map((id) => nodeById.get(id)).filter(Boolean);
    // A collection field the walk resolved as a pipeline holds its steps in the order the
    // source registered them, which is an order the source states.
    const pipeline = nodes.find((node) => (node.children || []).some((child) => Number.isInteger(child.step)));
    if (pipeline) return { kind: 'targets', node: pipeline, steps: pipeline.children.filter((child) => Number.isInteger(child.step)) };
    const raw = nodes.length > 0 ? descend(nodes[nodes.length - 1]) : null;
    const node = raw;
    if (!node) return { kind: 'stop', reason: record.skipped ? STOP_FOR_SKIP[record.skipped] || 'unresolved-target' : 'unresolved-target', node: null };
    const declaration = declarationOf(node);
    if (node.sink === true || node.kind === 'db') {
      if (node.stop) return { kind: 'stop', reason: node.stop, node };
      return { kind: 'sink', node: { id: node.id, declaration } };
    }
    if (node.stop) return { kind: 'stop', reason: node.stop, node };
    if (node.cycle) return { kind: 'stop', reason: 'cycle-guard', node };
    if (node.unresolved) return { kind: 'stop', reason: 'unresolved-target', node };
    const stepChildren = (node.children || []).filter((child) => Number.isInteger(child.step));
    if (stepChildren.length > 0) return { kind: 'targets', node, steps: stepChildren };
    if (CODE_BODY_KINDS.has(node.kind) && node.via !== 'graph' && node.kind !== 'message' && node.kind !== 'route') {
      return { kind: 'body', node };
    }
    // A body the walk could not enter has no code edge; the missing index is why, not a
    // statement about where the call ran.
    if (node.graph === 'unavailable') return { kind: 'stop', reason: 'code-index-unavailable', node };
    return { kind: 'hop', node };
  }

  function hopOf(node, seen, invocationId) {
    const key = foldKey(node);
    const shown = seen.get(key);
    const declaration = declarationOf(node);
    if (shown) return { kind: 'hop', node: node.id, declaration, site: null, see: shown };
    const hop = { kind: 'hop', node: node.id, declaration, site: null };
    seen.set(key, invocationId);
    if (node.children && node.children.length > 0) hop.body = bodyOf(node);
    return hop;
  }

  function bodyOf(node) {
    if (activePath.has(node.id)) return { node: node.id, caller: declarationOf(node), steps: [] };
    counts.bodies += 1;
    activePath.set(node.id, true);
    const body = { node: node.id, caller: declarationOf(node), steps: [] };
    const owner = { id: node.id, ref: node.ref, repo: node.repo, file: node.file, children: node.children };
    try {
      body.steps = stepsOf(owner, node);
    } finally {
      activePath.delete(node.id);
    }
    return body;
  }

  /**
   * The steps of one body: every call fact in its place among the frames that hold it, then
   * a join step for each task set that something joins, then the hops no call fact carries.
   */
  function stepsOf(owner, node) {
    const records = (callRecords.get(node.id) || []).slice();
    const steps = [];
    const known = new Set();
    const joins = new Map();
    const continuations = new Map();
    const joinSortSites = new Map();

    const header = headers.has(owner.repo) ? headers.get(owner.repo) : undefined;
    const kind = repoKinds.get(owner.repo);
    const readable = Number.isInteger(header) && header === CONTROL_EVIDENCE_VERSION;
    const providerOnly = records.length > 0 && records.every((record) => record.fact && record.fact.provenance);

    if (records.length > 0 && providerOnly) {
      return [unorderedGroup('provider-facts', null, records, node)];
    }
    if (records.length > 0 && kind === 'mobile') {
      return [unorderedGroup('mobile-body', null, records, node)];
    }
    if (records.length > 0 && !readable) {
      return [unorderedGroup('no-control-evidence', header === undefined || header === null ? 'extract again' : `control evidence version ${header}`, records, node)];
    }

    const readableRecords = [];
    const unreadable = [];
    const provided = [];
    for (const record of records) {
      // A fact an external provider supplied states a call, not where in the body it ran.
      if (record.fact && record.fact.provenance) {
        provided.push(record);
        continue;
      }
      const read = readControl(record.fact.control, { declaredVersion: Number.isInteger(header) ? header : undefined });
      if (!read.ok) {
        unreadable.push({ record, detail: read.detail });
        continue;
      }
      readableRecords.push({ record, read });
    }

    const frameSite = (frame) => ({ repo: node.repo, file: node.file ?? null, line: frame.line, column: frame.column });
    const buckets = frameTree(readableRecords);

    const build = (frameNode, fallInto) => {
      const items = [];
      for (const child of frameNode.children.values()) {
        const step = constructOf(child, fallInto);
        if (step) items.push(step);
      }
      for (const entry of frameNode.entries) {
        const step = invocationStep(owner, entry, node);
        if (step) items.push(step);
      }
      items.sort(bySite);
      return items;
    };

    const constructOf = (frameNode, fallInto) => {
      const frame = frameNode.frame;
      if (frame.kind === 'arm') return branchOf(frameNode, fallInto);
      if (frame.kind === 'try') return tryOf(frameNode, fallInto);
      if (frame.kind === 'continuation') {
        const key = `${frame.of.line}:${frame.of.column}`;
        const list = continuations.get(key) || [];
        list.push({ outcome: frame.outcome, site: frameSite(frame), steps: build(frameNode, fallInto) });
        continuations.set(key, list);
        return null;
      }
      if (frame.kind === 'loop') {
        return {
          kind: 'loop',
          form: frame.form,
          id: frame.id,
          site: frameSite(frame),
          text: frame.text,
          repeatable: true,
          steps: build(frameNode, fallInto),
        };
      }
      if (frame.kind === 'callback') {
        return {
          kind: 'callback',
          form: frame.form,
          id: frame.id,
          site: frameSite(frame),
          host: frame.host ?? null,
          scheduling: 'unknown',
          steps: build(frameNode, fallInto),
        };
      }
      if (frame.kind === 'async-form') {
        return {
          kind: 'unordered',
          reason: 'async-form',
          form: frame.form,
          detail: frame.form,
          sites: sitesOf(frameNode, node.repo),
          steps: build(frameNode, fallInto),
        };
      }
      return {
        kind: 'unordered',
        reason: 'independent-entries',
        sites: sitesOf(frameNode, node.repo),
        steps: build(frameNode, fallInto),
      };
    };

    const branchOf = (frameNode) => {
      const first = frameNode.frame;
      const byArm = new Map();
      // Every arm of one construct shares its id, so one tree node holds them all; the arm
      // each entry belongs to is read from its own path at this construct's depth.
      const collect = (holder) => {
        for (const entry of holder.entries) {
          const step = invocationStep(owner, entry, node);
          if (!step) continue;
          const own = entry.read.path.find((frame) => frame.id === first.id);
          const label = own ? own.arm : first.arm;
          const list = byArm.get(label) || [];
          list.push(step);
          byArm.set(label, list);
        }
        for (const child of holder.children.values()) collect(child);
      };
      collect(frameNode);
      const arms = [...byArm].map(([arm, list]) => ({ arm, steps: list.sort(bySite) }));
      if (arms.length === 0) arms.push({ arm: first.arm, steps: [] });
      // An `if` prints its then arm first whatever the call order is; every other
      // construct's arms carry no order of their own, so they print where their code sits.
      if (first.form === 'if') arms.sort((a, b) => (a.arm === 'then' ? -1 : 1) - (b.arm === 'then' ? -1 : 1));
      else arms.sort((a, b) => bySite(a.steps[0] || {}, b.steps[0] || {}));
      return {
        kind: 'branch',
        form: first.form,
        id: first.id,
        site: frameSite(first),
        text: first.text,
        arms,
      };
    };

    const tryOf = (frameNode) => {
      const first = frameNode.frame;
      const body = [];
      const catches = [];
      const final = [];
      const visit = (holder) => {
        for (const entry of holder.entries) {
          const step = invocationStep(owner, entry, node);
          if (!step) continue;
          const own = entry.read.path.find((frame) => frame.id === first.id);
          const part = own ? own.part : first.part;
          if (part === 'body') body.push(step);
          else if (part === 'finally') final.push(step);
          else catches.push({ part, steps: [step] });
        }
        for (const child of holder.children.values()) visit(child);
      };
      visit(frameNode);
      const merged = [];
      for (const entry of catches) {
        const found = merged.find((candidate) => candidate.part === entry.part);
        if (found) found.steps.push(...entry.steps);
        else merged.push({ ...entry });
      }
      return {
        kind: 'try',
        id: first.id,
        site: frameSite(first),
        text: first.text,
        body: body.sort(bySite),
        catches: merged.map((entry) => ({ ...entry, steps: entry.steps.sort(bySite) })),
        finally: final.sort(bySite),
      };
    };

    const invocationStep = (ownerBody, entry, ownerNode) => {
      const { record, read } = entry;
      const fact = record.fact;
      const index = entry.index;
      const invocation = invocationFor(ownerBody, record, index);
      counts.invocations += 1;
      const target = targetOf(record, ownerNode);
      const step = {
        kind: 'invocation',
        id: invocation.id,
        factSet: (digests.get(record.repo) || '').slice(0, 12),
        occurrence: invocation.occurrence,
        site: invocation.site,
        caller: declarationOf(ownerNode),
        declaration: target.node ? (target.kind === 'sink' ? target.node.declaration : declarationOf(target.node)) : null,
        node: target.node ? target.node.id : null,
        ...(target.node && target.node.via ? { via: target.node.via } : {}),
      };
      if (read.isAwait) step.await = true;
      if (read.task) {
        step.task = { id: read.task.id, local: read.task.local, join: read.task.join ? read.task.join.id : null };
        if (read.task.join) joins.set(read.task.join.id, read.task.join);
      }
      known.add(record);
      if (record.skipped === 'recursion') {
        // A direct self-call has no walk node of its own; it points back at the invocation
        // whose body it re-enters.
        step.declaration = declarationOf(ownerNode);
        step.target = { see: activeInvocations.get(ownerNode.id) || ownerNode.id, reason: 'recursion' };
        delete step.node;
        return step;
      }
      if (target.kind === 'targets') {
        // The walk read this order from the source's own step registration, so the targets
        // keep it rather than becoming an unknown-order group.
        step.target = {
          targets: target.steps
            .slice()
            .sort((a, b) => a.step - b.step)
            .map((child) => hopOf(child, shownHops, invocation.id)),
          order: 'step-composition',
        };
      } else if (target.kind === 'body') {
        const nodeKey = foldKey(target.node);
        if (activePath.has(target.node.id)) {
          const active = activeInvocations.get(target.node.id) || invocation.id;
          step.target = { see: active, reason: 'recursion' };
        } else if (shownBodies.has(nodeKey)) {
          step.target = { see: shownBodies.get(nodeKey), reason: 'shown-above' };
        } else {
          activeInvocations.set(target.node.id, invocation.id);
          const body = bodyOf(target.node);
          activeInvocations.delete(target.node.id);
          shownBodies.set(nodeKey, invocation.id);
          step.target = { body };
          const hidden = collapseOf(target.node, body);
          if (hidden) {
            step.infra = true;
            step.hidden = hidden;
          }
        }
      } else if (target.kind === 'sink') {
        step.target = { sink: true };
      } else if (target.kind === 'stop') {
        step.target = { stop: target.reason };
        frontier.push({ reason: target.reason, node: target.node ? target.node.id : null, site: invocation.site, invocation: invocation.id, declaration: step.declaration });
      } else {
        const hop = hopOf(target.node, shownHops, invocation.id);
        step.target = { hop };
        if (!hop.see) shownBodies.set(foldKey(target.node), invocation.id);
      }
      return step;
    };

    const shownHops = new Map();

    const bySite = (a, b) => {
      const left = joinSortSites.get(a) || firstSite(a);
      const right = joinSortSites.get(b) || firstSite(b);
      if (left.line !== right.line) return left.line - right.line;
      if ((left.column ?? 0) !== (right.column ?? 0)) return (left.column ?? 0) - (right.column ?? 0);
      return 0;
    };

    let index = 0;
    for (const entry of readableRecords) {
      entry.index = index;
      index += 1;
    }

    const nested = build(buckets, node);

    // A join step sorts after the last task it names, which is the rule that keeps a join
    // from printing above the launches it waits on.
    if (joins.size > 0) {
      const byTaskId = new Map();
      const collectTasks = (steps) => {
        for (const step of steps) {
          if (step.kind === 'invocation' && step.task) {
            if (!byTaskId.has(step.task.id)) byTaskId.set(step.task.id, step);
          }
          if (step.kind === 'branch') step.arms.forEach((arm) => collectTasks(arm.steps));
          else if (step.kind === 'try') {
            collectTasks(step.body);
            step.catches.forEach((entry) => collectTasks(entry.steps));
            collectTasks(step.finally);
          } else if (Array.isArray(step.steps)) collectTasks(step.steps);
        }
      };
      collectTasks(nested);
      for (const join of joins.values()) {
        const steps = join.tasks.map((id) => byTaskId.get(id)).filter(Boolean);
        const joinStep = {
          kind: 'join',
          form: join.form,
          id: join.id,
          site: { repo: node.repo, file: node.file ?? null, line: join.line, column: join.column },
          tasks: steps.map((step) => step.id),
        };
        const last = steps.reduce((best, step) => {
          if (!best) return step;
          const a = firstSite(best);
          const b = firstSite(step);
          return b.line > a.line || (b.line === a.line && (b.column ?? 0) > (a.column ?? 0)) ? step : best;
        }, null);
        if (last) joinSortSites.set(joinStep, firstSite(last));
        nested.push(joinStep);
      }
    }

    // A continuation answers the gateway call at its `of` site; anything whose request is
    // not in this body stays its own unknown-order group.
    for (const [key, entries] of continuations) {
      const invocation = findInvocationAt(nested, node.file ?? null, key);
      if (invocation) invocation.continuations = entries;
      else nested.push({ kind: 'unordered', reason: 'independent-entries', form: entries[0].outcome, sites: entries.map((entry) => entry.site), steps: [] });
    }

    // Records whose control evidence cannot be read are one group, at the end, with the
    // detail that names what failed.
    if (unreadable.length > 0) {
      nested.push({
        kind: 'unordered',
        reason: 'control-evidence-unreadable',
        detail: unreadable[0].detail,
        sites: unreadable.map((entry) => siteOf(entry.record.fact, entry.record.repo)),
        steps: [],
      });
    }
    if (provided.length > 0) {
      nested.push({
        kind: 'unordered',
        reason: 'provider-facts',
        sites: provided.map((record) => siteOf(record.fact, record.repo)),
        steps: [],
      });
    }

    // Whatever the walk reached from this body that no call record carries: a message, a
    // route, a code-index hop, a file-level effect. A class node whose method a record lands
    // on is that record's target, not a second hop beside it.
    const covered = new Set(records.flatMap((record) => record.nodes || []));
    const coveredMemo = new Map();
    const isCovered = (child) => {
      if (coveredMemo.has(child.id)) return coveredMemo.get(child.id);
      const result = covered.has(child.id) || (child.children || []).some(isCovered);
      coveredMemo.set(child.id, result);
      return result;
    };
    const leftovers = (node.children || []).filter((child) => !isCovered(child) && !child.stop && child.kind !== 'branch');
    const grouped = new Map();
    const ordered = [];
    for (const child of leftovers) {
      const steps = (child.children || []).filter((grandchild) => Number.isInteger(grandchild.step));
      if (steps.length > 0) {
        // A pipeline the walk resolved: the steps run in the order the source registered
        // them, so that order is stated rather than folded into an unknown group.
        ordered.push({
          kind: 'hop',
          node: child.id,
          declaration: declarationOf(child),
          site: siteOf(child, child.repo),
          order: 'step-composition',
          targets: steps
            .slice()
            .sort((a, b) => a.step - b.step)
            .map((grandchild) => ({ kind: 'hop', node: grandchild.id, declaration: declarationOf(grandchild), site: siteOf(grandchild, grandchild.repo) })),
        });
        continue;
      }
      const reason = hopReason(child);
      const list = grouped.get(reason) || [];
      list.push(child);
      grouped.set(reason, list);
    }
    nested.push(...ordered);
    for (const [reason, children] of grouped) {
      const sites = children.map((child) => siteOf(child, child.repo)).filter((site) => site.line);
      nested.push({
        kind: 'unordered',
        reason,
        sites,
        steps: children.map((child) => hopOf(child, shownHops, child.id)),
      });
      for (const child of children) {
        if (child.stop) frontier.push({ reason: child.stop, node: child.id, site: siteOf(child, child.repo), invocation: null, declaration: declarationOf(child) });
      }
    }

    nested.sort(bySite);
    return nested;
  }

  function collapseOf(node, body) {
    if (!internals.isShared(node)) return null;
    if (internals.carriesSeedWork(node)) return null;
    return { invocations: countInvocations(body), stops: countStops(body) };
  }

  function countInvocations(body) {
    let total = 0;
    const visit = (steps) => {
      for (const step of steps) {
        if (step.kind === 'invocation') total += 1;
        else if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
        else if (step.kind === 'try') {
          visit(step.body);
          step.catches.forEach((entry) => visit(entry.steps));
          visit(step.finally);
        } else if (Array.isArray(step.steps)) visit(step.steps);
      }
    };
    visit(body.steps);
    return total;
  }

  function countStops(body) {
    let total = 0;
    const visit = (steps) => {
      for (const step of steps) {
        if (step.kind === 'invocation' && step.target && step.target.stop) total += 1;
        else if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
        else if (step.kind === 'try') {
          visit(step.body);
          step.catches.forEach((entry) => visit(entry.steps));
          visit(step.finally);
        } else if (Array.isArray(step.steps)) visit(step.steps);
      }
    };
    visit(body.steps);
    return total;
  }

  function findInvocationAt(steps, file, key) {
    for (const step of steps) {
      if (step.kind === 'invocation' && step.site && key === `${step.site.line}:${step.site.column}`) return step;
      if (step.kind === 'branch') {
        for (const arm of step.arms) {
          const found = findInvocationAt(arm.steps, file, key);
          if (found) return found;
        }
      }
      if (step.kind === 'try') {
        const found = findInvocationAt(step.body, file, key) || findInvocationAt(step.finally, file, key);
        if (found) return found;
        for (const entry of step.catches) {
          const nested = findInvocationAt(entry.steps, file, key);
          if (nested) return nested;
        }
      }
      if (Array.isArray(step.steps)) {
        const found = findInvocationAt(step.steps, file, key);
        if (found) return found;
      }
    }
    return null;
  }

  function sitesOf(frameNode, repo) {
    const sites = [];
    const visit = (holder) => {
      for (const entry of holder.entries) sites.push(siteOf(entry.record.fact, entry.record.repo));
      for (const child of holder.children.values()) visit(child);
    };
    visit(frameNode);
    return sites;
  }

  function unorderedGroup(reason, detail, records, node) {
    counts.unordered += 1;
    const sites = records.map((record) => siteOf(record.fact, record.repo));
    const steps = [];
    for (const record of records) {
      const invocation = invocationFor(node, record, 0);
      counts.invocations += 1;
      steps.push({
        kind: 'invocation',
        id: invocation.id,
        factSet: (digests.get(record.repo) || '').slice(0, 12),
        occurrence: invocation.occurrence,
        site: invocation.site,
        caller: declarationOf(node),
        declaration: null,
        node: (record.nodes || [])[0] || null,
        target: { stop: 'unresolved-target' },
      });
    }
    return { kind: 'unordered', reason, ...(detail ? { detail } : {}), sites, steps };
  }

  const root = result.root ? descend(result.root) : null;
  let projectedRoot;
  if (!root) {
    projectedRoot = { kind: 'hop', via: 'start', node: null, declaration: null, site: null };
  } else {
    const declaration = declarationOf(root);
    const body = CODE_BODY_KINDS.has(root.kind) || (root.children || []).length > 0 ? bodyOf(root) : null;
    projectedRoot = { kind: 'hop', via: 'start', node: root.id, declaration, site: null, ...(body ? { body } : {}) };
  }

  counts.frontier = frontier.length;
  counts.unordered = countUnordered(projectedRoot.body || { steps: [] });

  return {
    schemaVersion: 1,
    evidence: 'static',
    controlEvidence,
    walk: {
      budgetHit: result.stats ? result.stats.budgetHit === true : false,
      ...(result.stats && result.stats.complete !== undefined ? { complete: result.stats.complete } : {}),
    },
    root: projectedRoot,
    frontier,
    counts: {
      bodies: counts.bodies,
      invocations: counts.invocations,
      unordered: counts.unordered,
      frontier: counts.frontier,
    },
  };
}

function countUnordered(body) {
  let total = 0;
  const visit = (steps) => {
    for (const step of steps) {
      if (step.kind === 'unordered') total += 1;
      if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
      else if (step.kind === 'try') {
        visit(step.body);
        step.catches.forEach((entry) => visit(entry.steps));
        visit(step.finally);
      } else if (Array.isArray(step.steps)) visit(step.steps);
    }
  };
  visit(body.steps);
  return total;
}

/** The first line and column a step is written at, for ordering. */
function firstSite(step) {
  if (step.site && Number.isInteger(step.site.line)) return { line: step.site.line, column: step.site.column };
  if (step.kind === 'branch') {
    for (const arm of step.arms) {
      if (arm.steps.length > 0) return firstSite(arm.steps[0]);
    }
  }
  if (step.kind === 'try') {
    if (step.body.length > 0) return firstSite(step.body[0]);
    for (const entry of step.catches) if (entry.steps.length > 0) return firstSite(entry.steps[0]);
    if (step.finally.length > 0) return firstSite(step.finally[0]);
  }
  return { line: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
}

/**
 * One position per call fact, counted in the fact set's own order, so two calls at one line
 * and column are told apart by which came first in the facts rather than by their order here.
 */
function occurrenceIndex(factSets) {
  const index = new Map();
  for (const set of factSets) {
    const counts = new Map();
    for (const fact of set.facts || []) {
      if (!['method_call', 'action_dispatch', 'gateway_call'].includes(fact.type)) continue;
      const key = [set.repo, fact.file, fact.line, fact.column ?? null, fact.class || '', fact.method || '', fact.field || '', fact.calledMethod || fact.action || fact.service || ''].join('|');
      const next = counts.get(key) || 0;
      if (!index.has(key)) index.set(key, next);
      counts.set(key, next + 1);
    }
  }
  return index;
}

/**
 * The frames every call of one body sits in, as a tree keyed by frame id. Two calls inside
 * one construct share its node, which is what makes an arm one branch rather than two.
 */
function frameTree(entries) {
  const root = { frame: null, children: new Map(), entries: [] };
  for (const entry of entries) {
    let holder = root;
    for (const frame of entry.read.path) {
      let child = holder.children.get(frame.id);
      if (!child) {
        child = { frame, children: new Map(), entries: [] };
        holder.children.set(frame.id, child);
      }
      holder = child;
    }
    holder.entries.push(entry);
  }
  return root;
}

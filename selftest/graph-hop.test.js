/**
 * The graph hop in `lib/trace.js`: which edge kinds widen the walk, in which order the
 * fan-out cap spends its slots, and what happens to a kind the build does not classify.
 *
 * These tests call `trace` in process against facts the CLI extracted from the synthetic
 * corpus, and hand it an `outbound` stub. The public corpus ships no code index, so a
 * stub is the only way the hop can be reached at all; the facts stay real so the node the
 * hop runs from is one the walk actually produces.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyCorpus, extract } from './helpers.js';
import { GRAPH_FANOUT, trace } from '../lib/trace.js';

const ROUTE = 'POST gizmos/v1/activate';
const HOP_FROM = 'GizmoController';
const EDGE_FILE = 'backend/src/Controllers/GizmoController.cs';

function corpusFacts(t) {
  const dir = copyCorpus(t);
  extract(dir);
  return {
    facts: JSON.parse(readFileSync(join(dir, 'out', 'facts', 'api.json'), 'utf8')),
    root: join(dir, 'backend'),
  };
}

/** One outbound edge, as the wrapper hands it over after parsing. */
function edge(kind, target) {
  return { kind, file: EDGE_FILE, line: 1, target };
}

/** Answers for one named class only, so the walk hops once and the children are countable. */
function stubFor(className, edges) {
  return (_root, name) => (name === className ? edges : []);
}

function walk(t, edges) {
  const { facts, root } = corpusFacts(t);
  return trace([facts], ROUTE, {
    repos: [{ id: 'api', root, role: ['api'] }],
    outbound: stubFor(HOP_FROM, edges),
    graph: true,
  });
}

function graphChildren(result) {
  return result.nodes.filter((node) => node.via === 'graph').map((node) => node.ref);
}

test('the fan-out cap goes to the structural kinds before member calls', (t) => {
  // Member calls come first in file order, so a cap spent in arrival order would keep
  // these four and one other, and lose the base, the interface and the injected type.
  const edges = [
    edge('uses-member', 'backend/src/Parts/Spindle.cs'),
    edge('uses-member', 'backend/src/Parts/Bushing.cs'),
    edge('uses-member', 'backend/src/Parts/Gasket.cs'),
    edge('uses-member', 'backend/src/Parts/Grommet.cs'),
    edge('inherits', 'backend/src/Parts/PartBase.cs'),
    edge('implements', 'backend/src/Parts/Assembler.cs'),
    edge('overrides', 'backend/src/Parts/Calibrator.cs'),
    edge('ctor-di', 'backend/src/Parts/Trimmer.cs'),
    edge('uses-type', 'backend/src/Parts/Lathe.cs'),
  ];
  assert.equal(edges.length, GRAPH_FANOUT + 1);

  const result = walk(t, edges);

  assert.deepEqual(graphChildren(result), [
    'PartBase',
    'Assembler',
    'Calibrator',
    'Trimmer',
    'Lathe',
    'Spindle',
    'Bushing',
    'Gasket',
  ]);
  const dropped = result.nodes.filter((node) => node.dropped !== undefined);
  assert.deepEqual(
    dropped.map((node) => node.dropped),
    [1],
    'the ninth candidate is refused by the cap and counted, not forgotten',
  );
});

test('a namespace import alone is not a reason to widen, and not a failed hop either', (t) => {
  const result = walk(t, [
    edge('imports', 'backend/src/Parts/Spindle.cs'),
    edge('imports', 'backend/src/Parts/Bushing.cs'),
  ]);

  assert.deepEqual(graphChildren(result), []);
  assert.equal(
    result.nodes.filter((node) => node.graph === 'unavailable').length,
    0,
    'an index that answered with informational edges answered',
  );
  assert.equal(result.stats.graphUnavailable, 0);
  assert.deepEqual(result.stats.graphUnknownKinds, []);
});

test('a kind the build does not classify is reported rather than widened on', (t) => {
  const result = walk(t, [
    edge('uses-type', 'backend/src/Parts/Lathe.cs'),
    edge('encloses', 'backend/src/Parts/Spindle.cs'),
    edge('annotates', 'backend/src/Parts/Bushing.cs'),
  ]);

  assert.deepEqual(graphChildren(result), ['Lathe'], 'only the classified kind widens');
  assert.deepEqual(
    result.stats.graphUnknownKinds,
    ['annotates', 'encloses'],
    'a reader has to be told which kind to classify, not only how many there were',
  );
  assert.equal(result.stats.graphUnavailable, 0, 'an unknown kind is not a broken index');
});

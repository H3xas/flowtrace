/**
 * `lib/scout.js` and the reach classification `lib/dotnet.js` builds on top of it.
 * Unlike the rest of this suite these tests import the library modules directly rather
 * than spawning the CLI: both functions here are pure parsing/decision logic over a
 * fixture payload with no process, filesystem or index binary involved, so there is
 * nothing a subprocess would exercise that an in-process call does not.
 *
 * The fixture graph below carries every edge kind the index currently declares, so a
 * kind the parser stops recognising, or a kind silently promoted from informational to
 * reach-worthy (or back), breaks one of these tests instead of narrowing results with
 * nothing to say so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRefs, parseRefsInbound } from '../lib/scout.js';
import { indexReferences } from '../lib/dotnet.js';

const ALL_KINDS = [
  'inherits',
  'uses-type',
  'uses-member',
  'ctor-di',
  'imports',
  'implements',
  'overrides',
].sort();

test('parseRefs reads every outbound sub-block the graph declares, not a fixed set', () => {
  const text = [
    'outbound:',
    '  inherits (1):',
    '    Backend/Widget.cs:10  inherits  -> Backend/Base.cs',
    '  uses-type (1):',
    '    Backend/Widget.cs:12  uses-type  -> Backend/Gizmo.cs',
    '  uses-member (1):',
    '    Backend/Widget.cs:14  uses-member  -> Backend/Sprocket.cs',
    '  ctor-di (1):',
    '    Backend/Widget.cs:16  ctor-di  -> Backend/IGearbox.cs',
    '  imports (1):',
    '    Backend/Widget.cs:2  imports  -> Backend/Cog.cs',
    '  implements (1):',
    '    Backend/Widget.cs:18  implements  -> Backend/IWidget.cs',
    '  overrides (2, 1 dropped):',
    '    Backend/Widget.cs:20  overrides  -> Backend/Base.cs',
    '',
  ].join('\n');

  const parsed = parseRefs(text);
  assert.equal(parsed.matched, true);
  assert.deepEqual(parsed.edges.map((edge) => edge.kind).sort(), ALL_KINDS);

  const ctorDi = parsed.edges.find((edge) => edge.kind === 'ctor-di');
  assert.deepEqual(ctorDi, { kind: 'ctor-di', file: 'Backend/Widget.cs', line: 16, target: 'Backend/IGearbox.cs' });

  // A sub-block's own row cap is a fact about that kind, not only about the three kinds
  // the parser used to recognise.
  assert.deepEqual(parsed.counts.overrides, { total: 2, dropped: 1 });
  assert.deepEqual(parsed.counts.imports, { total: 1, dropped: 0 });
});

test('parseRefsInbound reads every inbound kind object the payload declares', () => {
  const payload = {
    status: 'resolved',
    inbound: {
      inherits: { total: 1, dropped: 0, rows: [{ file: 'Tests/InheritsSpec.cs', line: 5 }] },
      'uses-type': { total: 1, dropped: 0, rows: [{ file: 'Tests/UsesTypeSpec.cs', line: 7 }] },
      'uses-member': { total: 1, dropped: 0, rows: [{ file: 'Tests/UsesMemberSpec.cs', line: 9 }] },
      'ctor-di': { total: 1, dropped: 0, rows: [{ file: 'Tests/CtorDiSpec.cs', line: 11 }] },
      imports: { total: 2, dropped: 1, rows: [{ file: 'Tests/ImportsSpec.cs', line: 2 }] },
      implements: { total: 1, dropped: 0, rows: [{ file: 'Tests/ImplementsSpec.cs', line: 13 }] },
      overrides: { total: 1, dropped: 0, rows: [{ file: 'Tests/OverridesSpec.cs', line: 15 }] },
    },
  };

  const parsed = parseRefsInbound(JSON.stringify(payload));
  assert.equal(parsed.matched, true);
  assert.deepEqual(parsed.edges.map((edge) => edge.kind).sort(), ALL_KINDS);
  // The dropped total now includes a kind the parser used to skip entirely, which is
  // exactly the silent under-count the fixed list produced.
  assert.equal(parsed.dropped, 1);
  assert.deepEqual(parsed.counts.imports, { total: 2, dropped: 1 });
});

test('the dotnet index only selects a test class through a structural inbound edge', () => {
  const classes = ALL_KINDS.map((kind) => ({
    class: `${kind.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}Spec`,
    file: `Tests/${kind}.cs`,
  }));
  const edges = ALL_KINDS.map((kind) => ({ kind, file: `Tests/${kind}.cs`, line: 1 }));
  const refs = () => edges;

  const result = indexReferences({ classes, tokens: ['Gizmo'], refs, root: 'repo-root' });
  const selected = [...result.hits.keys()].sort();

  assert.deepEqual(selected, [
    'CtorDiSpec',
    'ImplementsSpec',
    'InheritsSpec',
    'OverridesSpec',
    'UsesMemberSpec',
    'UsesTypeSpec',
  ]);
  assert.ok(
    !result.hits.has('ImportsSpec'),
    'a bare imports edge names a shared namespace, not a shared shape, so it must never select a test class on its own',
  );
});

/**
 * The source-flow view: the flag, the additive JSON, the call-site projection, the C# and web
 * control forms, the unknown-order groups, collapse and back-references, and the one
 * projection the terminal and the page share.
 *
 * Everything runs the CLI as a subprocess over a disposable copy of the invented
 * `tidewater-ferry` corpus, except the renderer test, which imports `lib/` to render from a
 * parsed `--json` answer because no command renders a JSON file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, copyFixture, runCli } from './helpers.js';
import { checkGoldens } from './dependency-goldens.js';
import { SOURCE_FLOW_LABEL, renderSourceFlowTrailer, sourceFlowLines } from '../lib/render-source-flow.js';
import { DEPENDENCY_LABEL } from '../lib/render-tree.js';

const CONFIG = 'ferry.config.json';
const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'tidewater-ferry');

function ferry(t) {
  const dir = copyFixture(t, 'tidewater-ferry');
  const cli = (args) => runCli([...args, '--config', CONFIG], { cwd: dir });
  const extracted = cli(['extract']);
  assert.equal(extracted.status, 0, extracted.stderr);
  return { dir, cli };
}

function json(env, key, extra = []) {
  const result = env.cli(['trace', key, '--json', ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function text(env, key, extra = []) {
  const result = env.cli(['trace', key, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Every step of the projection, whichever construct holds it. */
function allSteps(sourceFlow) {
  const out = [];
  const visit = (steps) => {
    for (const step of steps || []) {
      out.push(step);
      if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
      else if (step.kind === 'try') {
        visit(step.body);
        step.catches.forEach((entry) => visit(entry.steps));
        visit(step.finally);
      } else if (Array.isArray(step.steps)) visit(step.steps);
      if (step.target && step.target.body) visit(step.target.body.steps);
      if (step.body) visit(step.body.steps);
      for (const continuation of step.continuations || []) visit(continuation.steps);
    }
  };
  if (sourceFlow.root && sourceFlow.root.body) visit(sourceFlow.root.body.steps);
  return out;
}

/** The text of every line the page's tree block carries, tags removed. */
function pageLinesOf(page) {
  const open = page.indexOf('<pre class="tree">') + '<pre class="tree">'.length;
  const close = page.indexOf('</pre>', open);
  const tree = page.slice(open, close);
  return [...tree.matchAll(/<div class="ln[^"]*">(.*?)<\/div>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
  );
}

function invocations(sourceFlow) {
  return allSteps(sourceFlow).filter((step) => step.kind === 'invocation');
}

test('Source flow AC-1: the view flag chooses the projection and refuses every other value', (t) => {
  const env = ferry(t);
  const start = 'BoardingService.CheckInAsync';

  const source = env.cli(['trace', start, '--view', 'source-flow']);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout.split('\n')[0], SOURCE_FLOW_LABEL);

  const dependency = env.cli(['trace', start, '--view', 'dependency']);
  assert.equal(dependency.status, 0, dependency.stderr);
  assert.ok(dependency.stdout.split('\n').includes(DEPENDENCY_LABEL));

  const none = env.cli(['trace', start]);
  assert.equal(none.stdout, dependency.stdout);

  const equalsForm = env.cli(['trace', start, '--view=source-flow']);
  assert.equal(equalsForm.status, 0, equalsForm.stderr);
  assert.equal(equalsForm.stdout, source.stdout);

  for (const args of [['--view'], ['--view='], ['--view', 'flat']]) {
    const refused = env.cli(['trace', start, ...args]);
    assert.equal(refused.status, 2, `${args.join(' ')} should exit 2`);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /dependency/);
    assert.match(refused.stderr, /source-flow/);
  }

  const help = env.cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--view dependency\|source-flow/);
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8');
  assert.match(doc, /--view dependency\|source-flow/);
});

test('Source flow AC-2: the dependency view keeps its bytes and says it is not call order', async (t) => {
  const env = ferry(t);
  const start = 'BoardingService.CheckInAsync';

  const dependency = text(env, start);
  const dependencyLines = dependency.split('\n');
  const labelAt = dependencyLines.indexOf(DEPENDENCY_LABEL);
  assert.ok(labelAt >= 0, 'the dependency tree states which view it is');
  assert.equal(dependencyLines[labelAt - 1], '', 'the label opens the tree under the result header');
  const withoutLabel = dependencyLines.slice(labelAt + 1).join('\n');
  assert.match(withoutLabel, /BoardingService\.CheckInAsync/);

  for (const flag of ['--graph', '--mermaid']) {
    const refused = env.cli(['trace', start, flag, '--view', 'source-flow']);
    assert.equal(refused.status, 2, `${flag} with source-flow should exit 2`);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /source-flow/);
  }

  const html = join(env.dir, 'dependency.html');
  const written = env.cli(['trace', start, '--html', html]);
  assert.equal(written.status, 0, written.stderr);
  const page = readFileSync(html, 'utf8');
  const pageLines = pageLinesOf(page);
  assert.equal(pageLines[0], DEPENDENCY_LABEL);
  // The status lines stand between the label and the tree, on the terminal and in the page's
  // own status block. The tree itself must be the same text on both.
  const pageTree = pageLines.slice(1);
  const terminalLines = withoutLabel.split('\n');
  const treeStart = terminalLines.indexOf(pageTree[0]);
  assert.ok(treeStart >= 0, 'the page tree starts at the terminal tree');
  assert.deepEqual(terminalLines.slice(treeStart, treeStart + pageTree.length), pageTree);

  const goldens = await checkGoldens();
  assert.equal(goldens.ok, true, goldens.problems.join('\n'));
});

test('Source flow AC-3: the JSON answer is additive and declares its projection', (t) => {
  const env = ferry(t);
  const start = 'BoardingService.CheckInAsync';

  const dependency = json(env, start);
  assert.equal(dependency.view, 'dependency');
  assert.equal(dependency.sourceFlow, undefined);

  const source = json(env, start, ['--view', 'source-flow']);
  assert.equal(source.view, 'source-flow');
  assert.equal(source.sourceFlow.schemaVersion, 1);
  assert.equal(source.sourceFlow.evidence, 'static');
  assert.deepEqual(Object.keys(source).filter((key) => key !== 'sourceFlow'), Object.keys(dependency));
  assert.ok(Object.keys(source).includes('sourceFlow'));

  const { view: dependencyView, ...dependencyRest } = dependency;
  const { view: sourceView, sourceFlow, ...sourceRest } = source;
  assert.equal(dependencyView, 'dependency');
  assert.equal(sourceView, 'source-flow');
  assert.ok(sourceFlow);
  assert.equal(JSON.stringify(dependencyRest), JSON.stringify(sourceRest));

  writeFileSync(join(env.dir, 'area.txt'), `${start}\n`);
  const area = env.cli(['trace', '--area', 'area.txt', '--json', '--view', 'source-flow']);
  assert.equal(area.status, 0, area.stderr);
  const entries = JSON.parse(area.stdout);
  assert.equal(entries[0].view, 'source-flow');
  assert.ok(entries[0].sourceFlow);

  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8');
  assert.match(doc, /sourceFlow/);
});

test('Source flow AC-4: every C# and web call carries a column and its control evidence', (t) => {
  const env = ferry(t);
  for (const repo of ['backend', 'backend-mirrored', 'web']) {
    const set = JSON.parse(readFileSync(join(env.dir, 'out', 'facts', `${repo}.json`), 'utf8'));
    assert.equal(set.controlEvidence, 1, `${repo} declares the version`);
    const calls = set.facts.filter((fact) => ['method_call', 'action_dispatch', 'gateway_call'].includes(fact.type));
    assert.ok(calls.length > 0, `${repo} has calls`);
    for (const fact of calls) {
      assert.ok(Number.isInteger(fact.column) && fact.column > 0, `${repo} ${fact.file}:${fact.line} column`);
      assert.ok(fact.control === null || typeof fact.control === 'object', `${repo} ${fact.file}:${fact.line} control`);
    }
  }

  const doc = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8');
  assert.match(doc, /controlEvidence/);
  assert.match(doc, /### Control evidence/);
  for (const field of ['`column`', '`control`', '`path`', '`await`', '`task`']) assert.ok(doc.includes(field), field);
});

test('Source flow AC-5: an invocation is a call occurrence, not a callee declaration', (t) => {
  const env = ferry(t);
  const answer = json(env, 'BoardingService.RepeatForm', ['--view', 'source-flow']);
  const calls = invocations(answer.sourceFlow).filter((step) => step.site.line === 39);
  assert.equal(calls.length, 2, 'two calls on one line are two invocations');
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(calls[0].occurrence, 0);
  assert.equal(calls[1].occurrence, 0);
  assert.equal(calls[0].declaration.ref, calls[1].declaration.ref);
  assert.ok(calls[0].target.body, 'the first shows the body');
  assert.deepEqual(calls[1].target.reason, 'shown-above', 'the second links to it');

  const rebuilt = invocations(answer.sourceFlow).map((step) => step.id);
  assert.equal(new Set(rebuilt).size, rebuilt.length, 'every invocation id is unique');
});

test('Source flow AC-6: the four guarded calls keep call-site order in both mirrors', (t) => {
  const env = ferry(t);
  const expected = [
    'ResolveIdentityAsync',
    'FindRouteAsync',
    'FindFleetAsync',
    'LoadPermitsAsync',
  ];
  for (const [start, names] of [
    ['BoardingService.CheckInAsync', expected],
    ['GateService.CheckInAsync', ['ResolveIdentityAsync', 'FindRouteAsync', 'FindFleetAsync', 'LoadPermitsAsync']],
  ]) {
    const answer = json(env, start, ['--view', 'source-flow']);
    const steps = invocations(answer.sourceFlow);
    assert.deepEqual(steps.map((step) => step.declaration.ref.split('.').pop()), names);
    assert.deepEqual(steps.map((step) => step.site.line), [...steps.map((step) => step.site.line)].sort((a, b) => a - b));
    const guarded = allSteps(answer.sourceFlow).filter((step) => step.kind === 'branch');
    assert.equal(guarded.length, 2, 'both guards are constructs');
    assert.deepEqual(guarded[0].arms.map((arm) => arm.arm), ['then']);
    assert.deepEqual(guarded[1].arms.map((arm) => arm.arm), ['then']);
    for (const branch of guarded) {
      assert.equal(branch.arms[0].steps.length, 1, 'the guarded call is inside its then arm');
    }
  }
});

test('Source flow AC-7: the C# control forms keep their shape and never read as one order', (t) => {
  const env = ferry(t);
  const forms = (key) => allSteps(json(env, key, ['--view', 'source-flow']).sourceFlow);

  const guard = forms('TerminalForms.GuardForms');
  const branch = guard.find((step) => step.kind === 'branch');
  assert.deepEqual(branch.arms.map((arm) => arm.arm), ['then', 'else']);

  const switchy = forms('TerminalForms.SwitchForm');
  const cases = switchy.find((step) => step.kind === 'branch');
  assert.deepEqual(cases.arms.map((arm) => arm.arm), ['case 1', 'default']);

  const tried = forms('TerminalForms.TryForm').find((step) => step.kind === 'try');
  assert.equal(tried.body.length, 1);
  assert.deepEqual(tried.catches.map((entry) => entry.part), ['catch 1']);
  assert.equal(tried.finally.length, 1);

  const conditional = forms('TerminalForms.ConditionalForm');
  const conditionalForms = conditional.filter((step) => step.kind === 'branch').map((step) => step.form);
  for (const form of ['?:', '&&', '??', 'switch-expression']) assert.ok(conditionalForms.includes(form), form);
  assert.ok(conditional.some((step) => step.await === true));

  const ternary = conditional.find((step) => step.kind === 'branch' && step.form === '?:' && step.arms.length === 2);
  assert.ok(ternary, 'a ternary whose operands are calls is one construct with two arms');
  assert.deepEqual(ternary.arms.map((arm) => arm.arm), ['true', 'false']);
  assert.deepEqual(
    ternary.arms.map((arm) => arm.steps.map((step) => step.kind)),
    [['invocation'], ['invocation']],
    'each operand call sits in its own arm',
  );
  assert.deepEqual(
    ternary.arms.map((arm) => arm.steps[0].declaration.ref.split('.').pop()),
    ['ResolveIdentityAsync', 'ReadIdentityAsync'],
  );

  const switchExpression = conditional.find((step) => step.kind === 'branch' && step.form === 'switch-expression');
  assert.deepEqual(switchExpression.arms.map((arm) => arm.arm), ['arm 1', 'arm 2']);
  for (const arm of switchExpression.arms) assert.equal(arm.steps[0].kind, 'invocation');
  assert.ok(!conditional.some((step) => step.kind === 'callback'), 'an arm arrow is not a lambda callback');

  const nested = forms('TerminalForms.NestedForms');
  const outer = nested.find((step) => step.kind === 'branch');
  assert.deepEqual(outer.arms.map((arm) => arm.arm), ['then']);
  assert.deepEqual(outer.arms[0].steps.map((step) => step.kind), ['loop', 'try'], 'the loop and the try stay in the arm');
  const inner = outer.arms[0].steps[0].steps.find((step) => step.kind === 'branch');
  assert.deepEqual(inner.arms.map((arm) => arm.arm), ['then', 'else'], 'a nested alternative keeps both arms');
  for (const arm of inner.arms) assert.equal(arm.steps[0].kind, 'invocation');
  const nestedTry = outer.arms[0].steps[1];
  assert.deepEqual(nestedTry.body.map((step) => step.kind), ['branch'], 'the try body keeps its branch');
  assert.deepEqual(nestedTry.body[0].arms.map((arm) => arm.arm), ['then']);
  assert.deepEqual(nestedTry.catches.map((entry) => entry.part), ['catch 1']);
  assert.equal(nestedTry.catches[0].steps[0].kind, 'invocation');

  const joined = json(env, 'TerminalForms.JoinLater', ['--view', 'source-flow']).sourceFlow;
  const joinOrder = joined.root.body.steps;
  assert.deepEqual(joinOrder.map((step) => step.kind), ['invocation', 'invocation', 'join', 'invocation']);
  const [launch, between, join, after] = joinOrder;
  assert.equal(launch.task.local, 'pending');
  assert.deepEqual(join.tasks, [launch.id]);
  assert.ok(between.site.line < join.site.line, 'the join keeps its own position after the call between');
  assert.ok(join.site.line < after.site.line);

  const guarded = json(env, 'TerminalForms.GuardedAwait', ['--view', 'source-flow']).sourceFlow;
  assert.deepEqual(guarded.root.body.steps.map((step) => step.kind), ['invocation', 'branch', 'invocation']);
  const guardedArm = guarded.root.body.steps[1].arms.find((arm) => arm.arm === 'then');
  assert.deepEqual(guardedArm.steps.map((step) => step.kind), ['join'], 'a join written inside a guard stays in its arm');
  assert.deepEqual(guardedArm.steps[0].tasks, [guarded.root.body.steps[0].id], 'the launch outside the guard is the task it names');

  const loopJoin = forms('TerminalForms.LoopJoin');
  const perIteration = loopJoin.find((step) => step.kind === 'loop');
  assert.deepEqual(perIteration.steps.map((step) => step.kind), ['invocation', 'join'], 'a join written in a loop body stays in the loop');
  assert.deepEqual(perIteration.steps[1].tasks, [perIteration.steps[0].id]);

  const guardedAll = json(env, 'TerminalForms.GuardedAll', ['--view', 'source-flow']).sourceFlow;
  const allArm = guardedAll.root.body.steps.find((step) => step.kind === 'branch').arms.find((arm) => arm.arm === 'then');
  assert.deepEqual(allArm.steps.map((step) => step.kind), ['invocation', 'invocation', 'join'], 'a guarded join stays in its arm after its launches');
  assert.equal(allArm.steps[2].form, 'Task.WhenAll');
  assert.deepEqual(allArm.steps[2].tasks, [allArm.steps[0].id, allArm.steps[1].id]);

  const tryJoin = json(env, 'TerminalForms.TryJoin', ['--view', 'source-flow']).sourceFlow;
  const trySteps = tryJoin.root.body.steps.find((step) => step.kind === 'try');
  assert.deepEqual(trySteps.body.map((step) => step.kind), ['join'], 'a join written in a try body stays in the try');
  assert.equal(trySteps.body[0].tasks.length, 1);

  const callbackJoin = json(env, 'TerminalForms.CallbackJoin', ['--view', 'source-flow']).sourceFlow;
  const callback = allSteps(callbackJoin).find((step) => step.kind === 'callback');
  assert.deepEqual(callback.steps.map((step) => step.kind), ['join'], 'a join written in a lambda body stays in the callback');
  assert.equal(callback.steps[0].tasks.length, 1);

  const loops = forms('TerminalForms.LoopForms').filter((step) => step.kind === 'loop');
  assert.deepEqual(loops.map((step) => step.form), ['for', 'foreach', 'while', 'do']);
  for (const loop of loops) {
    assert.equal(loop.repeatable, true);
    assert.equal(loop.count, undefined);
  }

  const concurrent = forms('TerminalForms.ConcurrentForm');
  const joins = concurrent.filter((step) => step.kind === 'join');
  assert.deepEqual(joins.map((step) => step.form), ['Task.WhenAll', 'Task.WhenAny']);
  const launched = concurrent.filter((step) => step.task && step.task.join === null);
  assert.equal(launched.length, 1, 'a discard is launched and not joined');

  const callbacks = forms('TerminalForms.CallbackForm').filter((step) => step.kind === 'callback');
  assert.equal(callbacks.length, 2);
  for (const callback of callbacks) assert.equal(callback.scheduling, 'unknown');

  assert.ok(!JSON.stringify({ guard, switchy, tried, conditional, loops, concurrent, callbacks }).includes('"totalOrder"'));
});

test('Source flow AC-8: the web control forms keep their shape and name the async ones', (t) => {
  const env = ferry(t);
  const forms = (key) => allSteps(json(env, key, ['--view', 'source-flow']).sourceFlow);

  const boarding = forms('Boarding.loadBoarding');
  const awaits = boarding.filter((step) => step.await === true);
  assert.equal(awaits.length, 4, 'the two awaited requests, the guarded post and the loop body');
  const lines = awaits.map((step) => step.site.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), 'awaited calls keep source order');
  const branch = boarding.find((step) => step.kind === 'branch');
  assert.deepEqual(branch.arms.map((arm) => arm.arm), ['then', 'else']);
  assert.equal(boarding.filter((step) => step.kind === 'loop').length, 1);

  const nestedBoarding = forms('Boarding.loadNestedBoarding');
  const nestedBranch = nestedBoarding.find((step) => step.kind === 'branch');
  assert.deepEqual(nestedBranch.arms.map((arm) => arm.arm), ['then']);
  const nestedLoop = nestedBranch.arms[0].steps.find((step) => step.kind === 'loop');
  assert.ok(nestedLoop, 'the loop stays inside the branch arm');
  assert.equal(nestedLoop.repeatable, true);
  assert.equal(nestedLoop.steps[0].kind, 'invocation');
  assert.equal(nestedLoop.steps[0].await, true);

  const loaded = forms('Boarding.loadAll');
  assert.ok(loaded.some((step) => step.kind === 'loop' && step.form === 'map'), 'the map callback is the launch body');
  assert.ok(loaded.some((step) => step.kind === 'join' && step.form === 'Promise.all'));
  let launched = false;
  for (const step of loaded) if (step.task && step.task.join) launched = true;
  assert.ok(launched, 'the calls in the argument are launched tasks');

  const settled = forms('Boarding.loadSettled');
  assert.ok(settled.some((step) => step.kind === 'join' && step.form === 'Promise.allSettled'));

  const guardedAll = json(env, 'Boarding.loadGuardedAll', ['--view', 'source-flow']).sourceFlow;
  const guardedArm = guardedAll.root.body.steps.find((step) => step.kind === 'branch').arms.find((arm) => arm.arm === 'then');
  assert.deepEqual(guardedArm.steps.map((step) => step.kind), ['invocation', 'invocation', 'join'], 'a guarded Promise.all stays in its arm');
  assert.equal(guardedArm.steps[2].form, 'Promise.all');
  assert.deepEqual(guardedArm.steps[2].tasks, [guardedArm.steps[0].id, guardedArm.steps[1].id]);

  const loopedAll = json(env, 'Boarding.loadLoopedAll', ['--view', 'source-flow']).sourceFlow;
  const loop = loopedAll.root.body.steps.find((step) => step.kind === 'loop');
  assert.deepEqual(loop.steps.map((step) => step.kind), ['invocation', 'invocation', 'join'], 'a Promise.all in a loop body stays in the loop');
  assert.equal(loop.steps[2].form, 'Promise.all');

  const trySettled = json(env, 'Boarding.loadTrySettled', ['--view', 'source-flow']).sourceFlow;
  const trySteps = trySettled.root.body.steps.find((step) => step.kind === 'try');
  assert.deepEqual(trySteps.body.map((step) => step.kind), ['invocation', 'invocation', 'join'], 'a Promise.allSettled in a try body stays in the try');
  assert.equal(trySteps.body[2].form, 'Promise.allSettled');

  const fallback = json(env, 'Boarding.loadWithFallback', ['--view', 'source-flow']).sourceFlow;
  const gateway = invocations(fallback)[0];
  assert.deepEqual(gateway.continuations.map((entry) => entry.outcome), ['success', 'failure']);

  const race = forms('Boarding.loadFirst').find((step) => step.kind === 'unordered');
  assert.equal(race.reason, 'async-form');
  assert.equal(race.form, 'Promise.race');

  const effect = forms('Boarding.watchBoarding').find((step) => step.kind === 'callback');
  assert.equal(effect.form, 'async-effect-callback');
  assert.equal(effect.scheduling, 'unknown');

  const unknown = forms('Boarding.scheduleBoarding').find((step) => step.kind === 'callback');
  assert.equal(unknown.form, 'callback');
  assert.equal(unknown.scheduling, 'unknown');
});

test('Source flow AC-9: a body the facts cannot place is an unknown-order group with its reason', (t) => {
  const env = ferry(t);

  // An older extraction: the same facts with the header field removed.
  const file = join(env.dir, 'out', 'facts', 'backend.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  const older = { ...original, facts: original.facts.map(({ control, ...rest }) => rest) };
  delete older.controlEvidence;
  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
  const stale = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow']);
  const staleGroup = allSteps(stale.sourceFlow).find((step) => step.kind === 'unordered' && step.reason === 'no-control-evidence');
  assert.ok(staleGroup, 'an older extraction is unknown order');
  assert.ok(staleGroup.sites.length > 0);
  assert.match(staleGroup.detail, /extract again/);

  // A field the projection cannot read: an unknown arm.
  const edited = JSON.parse(JSON.stringify(original));
  const broken = edited.facts.find((fact) => fact.type === 'method_call' && fact.method === 'CheckInAsync');
  broken.control = { path: [{ kind: 'arm', form: 'if', id: 'if@21:13', line: 21, column: 13, text: 'if (x)', arm: 'whenever' }] };
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
  const unreadable = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow']);
  const unreadableGroup = allSteps(unreadable.sourceFlow).find((step) => step.kind === 'unordered' && step.reason === 'control-evidence-unreadable');
  assert.ok(unreadableGroup, 'an unreadable field is unknown order');
  assert.ok(unreadableGroup.sites.length > 0);

  // A join whose own path cannot be read: the projection invents no enclosing frame.
  const brokenJoin = JSON.parse(JSON.stringify(original));
  const launchFact = brokenJoin.facts.find((fact) => fact.type === 'method_call' && fact.method === 'JoinLater');
  launchFact.control.task.join.path = [{ kind: 'loop', form: 'while', id: 'for@1:1', line: 1, column: 1, text: 'while' }];
  writeFileSync(file, `${JSON.stringify(brokenJoin, null, 2)}\n`);
  const joinUnreadable = json(env, 'TerminalForms.JoinLater', ['--view', 'source-flow']);
  const joinGroup = allSteps(joinUnreadable.sourceFlow).find((step) => step.kind === 'unordered' && step.reason === 'control-evidence-unreadable');
  assert.ok(joinGroup, 'a join path the projection cannot read makes the body unknown order');

  // A provider fact in the same body.
  const provided = {
    producer: 'route-lister',
    version: '1.0.0',
    facts: [
      {
        type: 'method_call',
        file: 'src/Services/BoardingService.cs',
        line: 23,
        class: 'BoardingService',
        method: 'CheckInAsync',
        field: '_access',
        calledMethod: 'ResolveIdentityAsync',
      },
    ],
  };
  writeFileSync(file, JSON.stringify(original));
  writeFileSync(join(env.dir, 'provider.json'), `${JSON.stringify(provided, null, 2)}\n`);
  writeFileSync(
    join(env.dir, 'provided.config.json'),
    `${JSON.stringify(
      {
        out: 'out',
        repos: [
          { id: 'backend', kind: 'backend', root: 'backend', role: ['api'], factsProvider: { file: 'provider.json', merge: 'prefer-external' } },
          { id: 'web', kind: 'web', root: 'web' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const reextracted = runCli(['extract', '--config', 'provided.config.json'], { cwd: env.dir });
  assert.equal(reextracted.status, 0, reextracted.stderr);
  const providerAnswer = JSON.parse(
    runCli(['trace', 'BoardingService.CheckInAsync', '--json', '--view', 'source-flow', '--config', 'provided.config.json'], { cwd: env.dir }).stdout,
  );
  const providerGroup = allSteps(providerAnswer.sourceFlow).find((step) => step.kind === 'unordered' && step.reason === 'provider-facts');
  assert.ok(providerGroup, 'a provider fact is unknown order');

  // A mobile body: the nursery corpus has no control evidence at all.
  const nursery = copyFixture(t, 'nursery-mobile');
  const extracted = runCli(['extract', '--config', 'nursery.config.json'], { cwd: nursery });
  assert.equal(extracted.status, 0, extracted.stderr);
  const mobile = JSON.parse(
    runCli(['trace', 'PlotDetailPage', '--json', '--view', 'source-flow', '--config', 'nursery.config.json'], { cwd: nursery }).stdout,
  );
  const mobileGroup = allSteps(mobile.sourceFlow).find((step) => step.kind === 'unordered' && step.reason === 'mobile-body');
  assert.ok(mobileGroup, 'a mobile body is unknown order');

  // A pipeline keeps the order its facts state.
  const bakery = copyFixture(t, 'bakery-orders');
  const extractedBakery = runCli(['extract', '--config', 'bakery.config.json'], { cwd: bakery });
  assert.equal(extractedBakery.status, 0, extractedBakery.stderr);
  const pipeline = JSON.parse(
    runCli(['trace', 'POST bakery/v1/glazes', '--json', '--view', 'source-flow', '--config', 'bakery.config.json'], { cwd: bakery }).stdout,
  );
  const ordered = allSteps(pipeline.sourceFlow).find((step) => step.order === 'step-composition');
  assert.ok(ordered, 'a resolved pipeline states its run order');
  assert.deepEqual(ordered.targets.map((hop) => hop.declaration.ref), ['ZestStep', 'AlmondStep']);

  // No output says an order was watched at run time.
  const everyAnswer = text(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow']);
  assert.ok(!/observed|runtime-observed|at run time/i.test(everyAnswer));
});

test('Source flow AC-10: a shared call collapses in place and a later body is a back-reference', (t) => {
  const env = ferry(t);
  for (const line of Array.from({ length: 25 }, (_, index) => `        private readonly Shared${index} _shared${index};`)) {
    void line;
  }
  const file = join(env.dir, 'backend', 'src', 'Services', 'BoardingService.cs');
  const source = readFileSync(file, 'utf8');
  const ctorLines = Array.from({ length: 25 }, (_, index) => `        private readonly SharedGate${index} _gate${index};`).join('\n');
  const ctorParams = Array.from({ length: 25 }, (_, index) => `SharedGate${index} gate${index}`).join(', ');
  const ctorBody = Array.from({ length: 25 }, (_, index) => `            _gate${index} = gate${index};`).join('\n');
  const shared = Array.from(
    { length: 25 },
    (_, index) =>
      `    public class SharedGate${index}\n    {\n        public Task PingAsync()\n        {\n            return Task.CompletedTask;\n        }\n    }\n`,
  ).join('\n');
  const patched = source
    .replace('        private readonly IRouteLookup _lookup;', `        private readonly IRouteLookup _lookup;\n${ctorLines}`)
    .replace('public BoardingService(IPassengerAccess access, IRouteLookup lookup)', `public BoardingService(IPassengerAccess access, IRouteLookup lookup, ${ctorParams})`)
    .replace('            _lookup = lookup;', `            _lookup = lookup;\n${ctorBody}`)
    .replace('            await _lookup.FindRouteAsync(request.RouteId);', '            await _gate0.PingAsync();\n            await _lookup.FindRouteAsync(request.RouteId);');
  writeFileSync(file, `${patched}\n${shared}`);
  const reextract = env.cli(['extract']);
  assert.equal(reextract.status, 0, reextract.stderr);

  const answer = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow']);
  const expanded = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow', '--expand-infra']);
  const unfolded = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow', '--no-fold']);
  for (const variant of [expanded, unfolded]) {
    assert.equal(JSON.stringify(answer.sourceFlow), JSON.stringify(variant.sourceFlow));
    assert.equal(JSON.stringify(answer.stats), JSON.stringify(variant.stats));
  }

  const repeat = json(env, 'BoardingService.RepeatForm', ['--view', 'source-flow']);
  const shown = invocations(repeat.sourceFlow);
  assert.ok(shown.some((step) => step.target && step.target.see), 'a later call links to the body above');

  const recursive = json(env, 'BoardingService.RecursiveForm', ['--view', 'source-flow']);
  const cycles = allSteps(recursive.sourceFlow).filter((step) => step.target && step.target.reason === 'recursion');
  assert.ok(cycles.length >= 1, 'direct recursion is a back-reference');
  const mutual = json(env, 'BoardingService.MutualFirst', ['--view', 'source-flow']);
  assert.ok(allSteps(mutual.sourceFlow).some((step) => step.kind === 'invocation'));
});

test('Source flow AC-11: the terminal tree and the page render from the JSON projection alone', (t) => {
  const env = ferry(t);
  const start = 'BoardingService.CheckInAsync';
  const terminal = text(env, start, ['--view', 'source-flow']);
  const answer = json(env, start, ['--view', 'source-flow']);
  const rebuilt = [
    SOURCE_FLOW_LABEL,
    ...sourceFlowLines(answer.sourceFlow).map((line) => line.text),
    '',
    renderSourceFlowTrailer(answer.sourceFlow),
  ].join('\n');
  assert.equal(rebuilt, terminal.replace(/\n$/, ''));

  const html = join(env.dir, 'source.html');
  const written = env.cli(['trace', start, '--html', html, '--view', 'source-flow']);
  assert.equal(written.status, 0, written.stderr);
  const page = readFileSync(html, 'utf8');
  const pageLines = pageLinesOf(page);
  const terminalTree = terminal.replace(/\n$/, '').split('\n\n')[0].split('\n').slice(1);
  assert.deepEqual(pageLines, terminalTree);
});

test('Source flow AC-12: the site comes first and the limits stay visible', (t) => {
  const env = ferry(t);
  const answer = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow']);
  for (const step of invocations(answer.sourceFlow)) {
    assert.ok(Number.isInteger(step.site.line));
    assert.ok(Number.isInteger(step.site.column));
    assert.ok(step.site.file.startsWith('src/'));
    assert.ok(step.declaration && step.declaration.ref);
  }
  for (const line of sourceFlowLines(answer.sourceFlow).map((entry) => entry.text)) {
    if (line.includes(' → ')) assert.match(line.replace(/^[│├└─\s]+/, ''), /^\S+\.(cs|ts|tsx):\d+:\d+ → /, line);
  }

  assert.equal(answer.sourceFlow.walk.budgetHit, answer.stats.budgetHit);
  const trailer = renderSourceFlowTrailer(answer.sourceFlow);
  assert.match(trailer, /^source flow: \d+ invocations? in \d+ bod(y|ies) · \d+ unknown-order group/);

  const small = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow', '--max-nodes', '3']);
  assert.equal(small.sourceFlow.walk.budgetHit, true);
  assert.match(renderSourceFlowTrailer(small.sourceFlow), /node budget reached/);
  assert.ok(small.sourceFlow.frontier.some((stop) => stop.reason === 'node-budget'));

  const shallow = json(env, 'BoardingService.CheckInAsync', ['--view', 'source-flow', '--depth', '1']);
  assert.ok(shallow.sourceFlow.frontier.some((stop) => stop.reason === 'depth'));
});

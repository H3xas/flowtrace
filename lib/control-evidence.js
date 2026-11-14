/**
 * The control evidence a fact set carries: what holds a call inside its body, whether the
 * call is awaited, and whether it starts a task that some later join names.
 *
 * The extractor writes these fields and the source-flow projection reads them. Both sides
 * import the vocabulary from here, so a form the writer emits and a form the reader accepts
 * cannot drift apart. The reader fails closed: anything it cannot place makes the whole body
 * `control-evidence-unreadable` rather than an ordered guess.
 *
 * `control` on a call is `{ path, await?, task? }`. `path` lists the frames that hold the
 * call, outermost first. A frame is `{ kind, form, id, line, column, text, ... }` and `id`
 * is `<form>@<line>:<column>` of the construct it names. A task's `join` carries a `path`
 * of its own, because a task can launch outside a guard and be joined inside it.
 */

/** The version the facts header declares. A fact set without it carries no control evidence. */
export const CONTROL_EVIDENCE_VERSION = 1;

/** Frame kind -> the forms it may take, and the extra fields each form carries. */
export const FRAME_KINDS = Object.freeze({
  arm: Object.freeze({
    forms: Object.freeze(['if', 'switch', '?:', '&&', '||', '??', '?.', 'switch-expression']),
    arms: Object.freeze(['then', 'else', 'default', 'true', 'false', 'right', 'non-null']),
  }),
  try: Object.freeze({
    forms: Object.freeze(['try']),
    parts: Object.freeze(['body', 'finally']),
  }),
  loop: Object.freeze({
    forms: Object.freeze(['for', 'foreach', 'while', 'do', 'for-of', 'for-in', 'map']),
  }),
  callback: Object.freeze({
    forms: Object.freeze(['lambda', 'anonymous-method', 'local-function', 'callback', 'async-effect-callback']),
  }),
  continuation: Object.freeze({
    forms: Object.freeze(['then', 'catch']),
    outcomes: Object.freeze(['success', 'failure']),
  }),
  'async-form': Object.freeze({
    forms: Object.freeze(['Promise.race', 'Promise.any']),
  }),
});

/** The forms a task's join takes. */
export const JOIN_FORMS = Object.freeze(['await', 'Task.WhenAll', 'Task.WhenAny', 'Promise.all', 'Promise.allSettled']);

/** The reasons a body or a hop cannot be ordered. Closed: the projection emits no other. */
export const UNORDERED_REASONS = Object.freeze([
  'no-control-evidence',
  'provider-facts',
  'mobile-body',
  'control-evidence-unreadable',
  'code-index',
  'publish',
  'bus-consumer',
  'worker',
  'push',
  'http-out',
  'independent-entries',
  'interface-fanout',
  'unscoped',
  'async-form',
  'unclassified-hop',
]);

/** The reasons a walk stops. Closed: the projection emits no other. */
export const WALK_STOPS = Object.freeze([
  'unresolved-target',
  'depth',
  'node-budget',
  'unscoped-hop',
  'code-index-unavailable',
  'cycle-guard',
]);

/** The `<form>@<line>:<column>` identity of one construct. */
export function frameId(form, line, column) {
  return `${form}@${line}:${column}`;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isFrameShape(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'a frame is not an object';
  const kind = FRAME_KINDS[frame.kind];
  if (!kind) return `unknown frame kind "${String(frame.kind)}"`;
  if (!kind.forms.includes(frame.form)) return `unknown form "${String(frame.form)}" for kind "${frame.kind}"`;
  if (frame.id !== frameId(frame.form, frame.line, frame.column)) return `frame id does not name its own site`;
  if (!isPositiveInteger(frame.line) || !isPositiveInteger(frame.column)) return 'frame site is not a positive line and column';
  if (typeof frame.text !== 'string') return 'frame text is not a string';
  if (frame.kind === 'arm' && !FRAME_KINDS.arm.arms.includes(frame.arm) && !/^case\b/.test(String(frame.arm)) && !/^arm \d+$/.test(String(frame.arm))) {
    return `unknown arm "${String(frame.arm)}"`;
  }
  if (frame.kind === 'try') {
    if (!FRAME_KINDS.try.parts.includes(frame.part) && !/^catch \d+$/.test(String(frame.part))) {
      return `unknown try part "${String(frame.part)}"`;
    }
  }
  if (frame.kind === 'continuation') {
    if (!FRAME_KINDS.continuation.outcomes.includes(frame.outcome)) return `unknown continuation outcome "${String(frame.outcome)}"`;
    const of = frame.of;
    if (!of || typeof of !== 'object' || !isPositiveInteger(of.line) || !isPositiveInteger(of.column)) {
      return 'continuation names no call it answers';
    }
  }
  if (frame.kind === 'callback' && frame.host !== null && typeof frame.host !== 'string') {
    return 'callback host is neither a name nor null';
  }
  return null;
}

/**
 * Read one call's `control`. Returns `{ ok: true, path, isAwait, task }` or
 * `{ ok: false, detail }`; the caller turns a failure into an unknown-order group.
 */
export function readControl(control, { declaredVersion } = {}) {
  if (declaredVersion !== undefined && declaredVersion !== CONTROL_EVIDENCE_VERSION) {
    return { ok: false, detail: `control evidence version ${declaredVersion}` };
  }
  if (control === null || typeof control !== 'object' || Array.isArray(control)) {
    return { ok: false, detail: 'control is absent' };
  }
  const path = Array.isArray(control.path) ? control.path : null;
  if (!path) return { ok: false, detail: 'control path is not a list' };
  const ids = new Set();
  for (const frame of path) {
    const problem = isFrameShape(frame);
    if (problem) return { ok: false, detail: problem };
    if (ids.has(frame.id)) return { ok: false, detail: 'one call carries the same frame twice' };
    ids.add(frame.id);
  }
  const isAwait = control.await === true;
  if (control.await !== undefined && control.await !== true) return { ok: false, detail: 'await is neither true nor absent' };
  const task = control.task;
  if (task === undefined) return { ok: true, path, isAwait, task: null };
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return { ok: false, detail: 'task is not an object' };
  if (isAwait) return { ok: false, detail: 'a call is both awaited and a task launch' };
  if (typeof task.id !== 'string' || !/^\d+:\d+$/.test(task.id)) return { ok: false, detail: 'task id is not <line>:<column>' };
  if (task.local !== null && typeof task.local !== 'string') return { ok: false, detail: 'task local is neither a name nor null' };
  const join = task.join;
  if (join === null) return { ok: true, path, isAwait, task: { id: task.id, local: task.local, join: null } };
  if (typeof join !== 'object' || Array.isArray(join)) return { ok: false, detail: 'task join is not an object' };
  if (!JOIN_FORMS.includes(join.form)) return { ok: false, detail: `unknown join form "${String(join.form)}"` };
  if (!isPositiveInteger(join.line) || !isPositiveInteger(join.column)) return { ok: false, detail: 'join site is not a positive line and column' };
  if (join.id !== `${join.line}:${join.column}`) return { ok: false, detail: 'join id does not name its own site' };
  if (!Array.isArray(join.tasks) || join.tasks.some((id) => typeof id !== 'string')) {
    return { ok: false, detail: 'join tasks is not a list of task ids' };
  }
  // The join's own path says where the `await` or the `Promise.all` is written. A task can
  // launch outside a guard and be joined inside it, so this is not the launch's path.
  const joinPath = join.path === undefined ? [] : join.path;
  if (!Array.isArray(joinPath)) return { ok: false, detail: 'join path is not a list' };
  const joinIds = new Set();
  for (const frame of joinPath) {
    const problem = isFrameShape(frame);
    if (problem) return { ok: false, detail: problem };
    if (joinIds.has(frame.id)) return { ok: false, detail: 'one join carries the same frame twice' };
    joinIds.add(frame.id);
  }
  return {
    ok: true,
    path,
    isAwait,
    task: {
      id: task.id,
      local: task.local,
      join: { id: join.id, form: join.form, line: join.line, column: join.column, tasks: join.tasks, path: joinPath },
    },
  };
}

/**
 * What one construct is, whichever arm or part of it a call sits in: every call that names
 * the frame id must state the same of it.
 */
function constructOf(frame) {
  const { arm, part, ...rest } = frame;
  return JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
}

/**
 * Read every call of one body together. A frame id must describe the same construct at every
 * call that carries it, and one join id must describe one join. A join is only ever read from
 * a call it launches, so it must list that call's task, and every task it names must be one
 * that a call of the body carries.
 * Returns `{ ok: true, calls }` — `calls` is `[{ site, control, path, isAwait, task }]` — or
 * `{ ok: false, detail }`.
 */
export function readBody(calls, { declaredVersion } = {}) {
  const byId = new Map();
  const read = [];
  const sameConstruct = (frame) => {
    const shape = constructOf(frame);
    if (!byId.has(frame.id)) byId.set(frame.id, shape);
    return byId.get(frame.id) === shape;
  };
  for (const call of calls) {
    const result = readControl(call.control, { declaredVersion });
    if (!result.ok) return { ok: false, detail: result.detail };
    if (!result.path.every(sameConstruct)) {
      return { ok: false, detail: 'two calls describe one frame id with different constructs' };
    }
    if (result.task && result.task.join && !result.task.join.path.every(sameConstruct)) {
      return { ok: false, detail: 'two records describe one frame id with different constructs' };
    }
    read.push({ site: call.site, control: call.control, path: result.path, isAwait: result.isAwait, task: result.task });
  }
  const carried = new Set(read.filter((call) => call.task).map((call) => call.task.id));
  const joins = new Map();
  for (const call of read) {
    if (!call.task || !call.task.join) continue;
    const join = call.task.join;
    if (!join.tasks.includes(call.task.id)) {
      return { ok: false, detail: 'a join does not list its own task' };
    }
    if (!join.tasks.every((id) => carried.has(id))) {
      return { ok: false, detail: 'a join names a task no call of the body carries' };
    }
    const shape = JSON.stringify([join.form, join.line, join.column, join.tasks, join.path]);
    if (joins.has(join.id) && joins.get(join.id) !== shape) {
      return { ok: false, detail: 'two calls describe one join id with different joins' };
    }
    joins.set(join.id, shape);
  }
  return { ok: true, calls: read };
}

/**
 * Keep in each join only the tasks some call fact of the same file carries. The scanner
 * reads every call written in a join's operands, and some of them are no call fact: a delay,
 * the `.map` that builds a launch's array, the receiver call of a chain. The reader refuses
 * a join that names a task no call carries, so the extractor writes only the ones it can.
 * Task ids are `<line>:<column>`, so one file is their whole scope.
 */
export function keepCarriedJoinTasks(facts) {
  const carried = new Map();
  for (const fact of facts) {
    const task = fact.control && fact.control.task;
    if (!task || typeof task.id !== 'string') continue;
    if (!carried.has(fact.file)) carried.set(fact.file, new Set());
    carried.get(fact.file).add(task.id);
  }
  for (const fact of facts) {
    const task = fact.control && fact.control.task;
    if (!task || !task.join || !Array.isArray(task.join.tasks)) continue;
    const ids = carried.get(fact.file);
    fact.control = { ...fact.control, task: { ...task, join: { ...task.join, tasks: task.join.tasks.filter((id) => ids.has(id)) } } };
  }
  return facts;
}

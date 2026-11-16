/**
 * The one rule for the status a thrown exception type answers the caller. Within the
 * repository that throws it, the controller action's own `catch (T)` runs first, then a
 * globally registered filter for `T`, then the action's bare `catch`, and only then the
 * repository's configured `exceptionStatuses` table. A table states what a type answers when
 * nothing in the source catches it, so it never overrides a catch or a filter, and it never
 * answers for a type another repository throws.
 */

/** Per repository: action-scoped maps by `Controller.Action`, global maps by type, the table. */
export function buildExceptionIndex(factSets, repos) {
  const index = new Map();
  const entryFor = (repo) => {
    if (!index.has(repo)) index.set(repo, { byAction: new Map(), globalByType: new Map(), table: new Map() });
    return index.get(repo);
  };
  for (const set of factSets || []) {
    for (const fact of set.facts || []) {
      if (fact.type !== 'exception_map') continue;
      const entry = {
        scope: fact.scope,
        exception: fact.exception,
        status: String(fact.status),
        via: fact.scope === 'action' ? `${fact.class}.${fact.method}` : fact.class,
        file: fact.file,
        line: fact.line,
      };
      const own = entryFor(set.repo);
      if (fact.scope === 'action') {
        const key = `${fact.class}.${fact.method}`;
        own.byAction.set(key, [...(own.byAction.get(key) || []), entry]);
      } else {
        own.globalByType.set(fact.exception, entry);
      }
    }
  }
  for (const repo of repos || []) {
    for (const [type, status] of Object.entries(repo.exceptionStatuses || {})) {
      entryFor(repo.id).table.set(type, { scope: 'table', exception: type, status: String(status), via: `${repo.id} exceptionStatuses` });
    }
  }
  return index;
}

/** The mapping `type` takes when `repo` throws it under `Controller.Action`, or null. */
export function exceptionStatus(index, repo, type, controller, action) {
  const own = index.get(repo);
  if (!own || !type) return null;
  const scoped = own.byAction.get(`${controller}.${action}`) || [];
  return (
    scoped.find((entry) => entry.exception === type) ||
    own.globalByType.get(type) ||
    scoped.find((entry) => entry.exception === '*') ||
    own.table.get(type) ||
    null
  );
}

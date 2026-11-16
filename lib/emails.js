/**
 * Static links from the email reads of tests to the templates and backend senders they name.
 *
 * A link is a static match, never proof that an email was sent: the read pattern meets a
 * template subject, the template id meets one sender, and nothing here runs or observes either.
 */

/** One test, named by repository, spec and the declaration line of the test. */
export const testKey = (repo, spec, line) => JSON.stringify([repo, spec, line]);

const READ_STAR = '\u0000';

/**
 * Whether the template subject `template` matches each subject the read pattern `read` stands
 * for. A `*` of the template takes any text; a `*` of the read stands for any text, so only a
 * `*` of the template can take it.
 */
export function subjectMatches(template, read) {
  const body = template
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${body}$`).test(read.split('*').join(READ_STAR));
}

function collect(factSets, type) {
  const out = [];
  for (const set of factSets) for (const fact of set.facts || []) if (fact.type === type) out.push({ repo: set.repo, fact });
  return out;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function linkOf(read, templates, senders) {
  if (typeof read.subject !== 'string') return { state: 'no-subject' };
  const matched = templates.filter(({ fact }) => typeof fact.subject === 'string' && subjectMatches(fact.subject, read.subject));
  if (matched.length === 0) return { state: 'no-template' };
  if (matched.length > 1) {
    return {
      state: 'ambiguous-template',
      candidates: matched.map(({ repo, fact }) => ({ repo, id: fact.id, file: fact.file, subject: fact.subject })),
    };
  }
  const [{ repo, fact: found }] = matched;
  const template = { repo, id: found.id, file: found.file, subject: found.subject };
  const named = typeof found.id === 'string' ? senders.filter(({ fact }) => fact.id === found.id) : [];
  const senderOf = ({ repo: senderRepo, fact }) => ({ repo: senderRepo, class: fact.class, member: fact.member, file: fact.file, line: fact.line });
  if (named.length === 0) return { state: 'no-sender', template };
  if (named.length > 1) return { state: 'ambiguous-sender', template, candidates: named.map(senderOf) };
  return { state: 'linked', template, sender: senderOf(named[0]) };
}

/**
 * The email reads that concern an area. A read is listed when its test holds named evidence on
 * an area route (`routesByTest`, by `testKey`), or when its linked sender is a node of the walk
 * of an area route (`walks`, route key to walk). `outsideArea` counts the other reads.
 */
export function emailReport(factSets, { routesByTest, walks }) {
  const templates = collect(factSets, 'email_template');
  const senders = collect(factSets, 'email_sender');
  const classRoutes = new Map();
  for (const [key, walked] of walks) {
    for (const node of (walked && walked.nodes) || []) {
      if (typeof node.class !== 'string') continue;
      const at = `${node.repo}\u0000${node.class}`;
      if (!classRoutes.has(at)) classRoutes.set(at, new Set());
      classRoutes.get(at).add(key);
    }
  }
  const emails = [];
  let outsideArea = 0;
  for (const { repo, fact } of collect(factSets, 'email_read')) {
    const link = linkOf(fact, templates, senders);
    const routes = [...(routesByTest.get(testKey(repo, fact.spec, fact.testLine)) || [])].sort(byText);
    const senderRoutes = link.sender ? [...(classRoutes.get(`${link.sender.repo}\u0000${link.sender.class}`) || [])].sort(byText) : [];
    if (routes.length === 0 && senderRoutes.length === 0) {
      outsideArea += 1;
      continue;
    }
    emails.push({
      repo,
      spec: fact.spec,
      test: fact.test,
      testLine: fact.testLine,
      file: fact.file,
      line: fact.line,
      call: fact.call,
      subject: fact.subject,
      ...(fact.reason ? { reason: fact.reason } : {}),
      skipped: fact.skipped === true,
      ...link,
      routes,
      senderRoutes,
    });
  }
  emails.sort((a, b) => byText(a.repo, b.repo) || byText(a.spec, b.spec) || a.testLine - b.testLine || a.line - b.line);
  return { emails, outsideArea };
}

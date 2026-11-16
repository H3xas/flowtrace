import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../lib/config.js';
import { factIdentity, validateFacts } from '../lib/facts.js';
import { copyFixture, extractRepoFacts, runCli, writeRepo } from './helpers.js';

const EMAIL_REFUSAL =
  '"email" must be an object with optional "reads" and "senders": "reads" an array of ' +
  '{ "call": <call name>, "subject": <argument index, or "<index>.<key>"> }, "senders" an array of { "member": <member name> }';
const TEMPLATES_REFUSAL =
  '"repos[1].templates" must be an object with "files" (a non-empty array of glob strings), "id" and "subject" ' +
  '(each a selector: dotted keys, where a key may be followed by [field=value])';

const TEMPLATES = { files: ['templates/*.json'], id: 'meta.code', subject: 'channels[kind=email].sections[role=subject].text' };

const MISSING = Symbol('missing');

function configWith(fields, templates = TEMPLATES) {
  return {
    out: 'out',
    repos: [
      { id: 'api', kind: 'backend', root: 'backend' },
      { id: 'mail', kind: 'email-templates', root: 'mail', ...(templates === MISSING ? {} : { templates }) },
    ],
    ...fields,
  };
}

const refusalOf = (raw) => {
  try {
    validateConfig(raw, { baseDir: '/work', file: '/work/flowtrace.config.json', env: {} });
  } catch (error) {
    return error.message;
  }
  return null;
};

test('Test evidence AC-22: each malformed email value is one refusal that names email', () => {
  const malformed = {
    'not an object': 'inbox',
    'an array': [{ call: 'readMail', subject: 1 }],
    'an unknown key': { reads: [], clients: [] },
    'reads that is not an array': { reads: { call: 'readMail', subject: 1 } },
    'a read that is not an object': { reads: ['readMail'] },
    'a read with an unknown key': { reads: [{ call: 'readMail', subject: 1, inbox: 'x' }] },
    'a read call that is not a callee': { reads: [{ call: 'read mail', subject: 1 }] },
    'a read with no subject': { reads: [{ call: 'readMail' }] },
    'a negative index': { reads: [{ call: 'readMail', subject: -1 }] },
    'a fractional index': { reads: [{ call: 'readMail', subject: 1.5 }] },
    'a position that is a bare key': { reads: [{ call: 'readMail', subject: 'subject' }] },
    'a position with two keys': { reads: [{ call: 'readMail', subject: '0.a.b' }] },
    'a position with a key that is not a name': { reads: [{ call: 'readMail', subject: '0.' }] },
    'senders that is not an array': { senders: 'EmailCode' },
    'a sender with an unknown key': { senders: [{ member: 'EmailCode', type: 'x' }] },
    'a sender member that is not a name': { senders: [{ member: 'Email Code' }] },
  };
  for (const [label, email] of Object.entries(malformed)) {
    assert.equal(refusalOf(configWith({ email })), `config /work/flowtrace.config.json: ${EMAIL_REFUSAL}`, label);
  }
  const accepted = validateConfig(
    configWith({ email: { reads: [{ call: 'mail.read', subject: 1 }, { call: 'readMail', subject: '0.subject' }], senders: [{ member: 'EmailCode' }] } }),
    { baseDir: '/work', file: '/work/flowtrace.config.json', env: {} },
  );
  assert.deepEqual(accepted.email, {
    reads: [
      { call: 'mail.read', subject: { index: 1, key: null } },
      { call: 'readMail', subject: { index: 0, key: 'subject' } },
    ],
    senders: [{ member: 'EmailCode' }],
  });
  assert.deepEqual(validateConfig(configWith({}), { baseDir: '/work', file: '/work/flowtrace.config.json', env: {} }).email, {
    reads: [],
    senders: [],
  });
});

test('Test evidence AC-22: each malformed templates value is one refusal that names templates', () => {
  const malformed = {
    missing: MISSING,
    'not an object': 'templates/*.json',
    'an unknown key': { ...TEMPLATES, locale: 'en' },
    'files that is not an array': { ...TEMPLATES, files: 'templates/*.json' },
    'files that is empty': { ...TEMPLATES, files: [] },
    'a glob that is not a string': { ...TEMPLATES, files: [7] },
    'an id selector that does not parse': { ...TEMPLATES, id: 'meta..code' },
    'a subject selector with an open filter': { ...TEMPLATES, subject: 'channels[kind=email.text' },
    'a subject selector with a nested filter': { ...TEMPLATES, subject: 'channels[kind=[email]].text' },
    'a filter with no value sign': { ...TEMPLATES, subject: 'channels[kind].text' },
    'a selector that is not a string': { ...TEMPLATES, id: ['meta', 'code'] },
  };
  for (const [label, templates] of Object.entries(malformed)) {
    assert.equal(refusalOf(configWith({}, templates)), `config /work/flowtrace.config.json: ${TEMPLATES_REFUSAL}`, label);
  }
  const misplaced = configWith({});
  misplaced.repos[0].templates = TEMPLATES;
  assert.match(refusalOf(misplaced), /"repos\[0\]\.templates" applies to an email-templates repository only/);
});

test('Test evidence AC-22: a malformed email value stops the command with the configuration exit code', (t) => {
  const dir = copyFixture(t, 'kite-club');
  const config = JSON.parse(readFileSync(join(dir, 'kite.config.json'), 'utf8'));
  writeFileSync(join(dir, 'malformed.config.json'), JSON.stringify({ ...config, email: { reads: 'readMail' } }));
  const result = runCli(['extract', '--config', 'malformed.config.json'], { cwd: dir });
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.split('\n')[0].endsWith(`malformed.config.json: ${EMAIL_REFUSAL}`), result.stderr);
});

test('Test evidence AC-22: without the email key an extract gives no email fact', (t) => {
  const dir = copyFixture(t, 'kite-club');
  const files = {
    'suite/e2e/mail.pw.ts': "import { test } from '@playwright/test';\n\ntest('a read', async () => {\n  await readMail({ subject: 'Welcome' });\n});\n",
    'backend/Mail/Welcome.cs': 'namespace Kite.Mail\n{\n    public class WelcomeEmail\n    {\n        public string EmailCode => "welcome";\n    }\n}\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const extracted = runCli(['extract', '--config', 'kite.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  for (const repo of ['api', 'web', 'mobile', 'suite']) {
    const facts = JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
    assert.deepEqual(facts.filter((fact) => fact.type.startsWith('email_')), [], repo);
  }
});

test('an email fact states a null with a reason, and two facts of one type have two identities', () => {
  const read = { type: 'email_read', file: 'e2e/a.pw.ts', line: 4, spec: 'e2e/a.pw.ts', test: 'a', testLine: 3, call: 'readMail', subject: 'Welcome', skipped: false };
  const template = { type: 'email_template', file: 'templates/a.json', line: 1, id: 'welcome', subject: 'Welcome *' };
  const sender = { type: 'email_sender', file: 'Mail/A.cs', line: 5, class: 'WelcomeEmail', member: 'EmailCode', id: 'welcome' };
  const visit = { type: 'pw_visit', file: 'e2e/a.pw.ts', line: 4, spec: 'e2e/a.pw.ts', test: 'a', testLine: 3, skipped: false, path: '/join', where: 'helper' };
  assert.equal(validateFacts([read, template, sender, visit, { ...read, test: null }]), 5);
  assert.equal(
    validateFacts([
      { ...read, subject: null, reason: 'unreadable-subject' },
      { ...template, id: null, reason: 'no-element' },
      { ...template, subject: null, reason: 'two-elements' },
      { ...sender, id: null, reason: 'no-constant' },
    ]),
    4,
  );
  assert.throws(() => validateFacts([{ ...read, subject: null }]), /missing required field "subject"/);
  assert.throws(() => validateFacts([{ ...template, id: null }]), /missing required field "id"/);
  assert.throws(() => validateFacts([{ ...sender, id: null }]), /missing required field "id"/);
  assert.throws(() => validateFacts([{ ...visit, testLine: null }]), /missing required field "testLine"/);
  for (const [one, other] of [
    [read, { ...read, testLine: 9 }],
    [template, { ...template, file: 'templates/b.json' }],
    [sender, { ...sender, class: 'ResetEmail' }],
    [visit, { ...visit, testLine: 9 }],
    [{ ...visit, type: 'cypress_visit' }, { ...visit, type: 'cypress_visit', testLine: 9 }],
  ]) {
    assert.notEqual(factIdentity(one), factIdentity(other), one.type);
  }
});

const READ_SPEC = `import { test } from '@playwright/test';

const TITLE = 'a title held in a const';

async function checkWelcome() {
  await readMail({ subject: 'Welcome to the club' });
}

test('a literal subject', async () => {
  await readMail({ subject: 'Welcome to the club', inbox: 'members' });
});

test('a template subject', async () => {
  await readMail({ subject: \`Code \${code} for \${member.name}\` });
});

test('a const subject', async () => {
  const subject = 'Your invite';
  await readMail({ subject });
  const reset = \`Reset \${count}\`;
  await this.inbox.latest(box, reset);
});

test('an unreadable subject', async () => {
  await readMail({ subject: makeSubject() });
  await readMail('no object');
});

test(TITLE, async () => {
  await readMail({ subject: 'Hello' });
});

test.describe('hooks', () => {
  test.beforeEach(async () => {
    await checkWelcome();
  });
  test('a read through a hook and a helper', async () => {
    await readMessage({ subject: 'not configured' });
  });
});

test.skip('a skipped read', async () => {
  await readMail({ subject: 'Skipped' });
});
`;

const READ_CY = `describe('reads', () => {
  it('a cypress read', () => {
    cy.readMail({ subject: 'Welcome to the club' });
    readMail({ subject: 'a plain call is not a command' });
  });
  it(\`a title with \${name}\`, () => {
    cy.checkWelcome();
  });
});
`;

const READ_COMMANDS = `Cypress.Commands.add('checkWelcome', () => {
  const subject = \`Welcome \${Cypress.env('member')}\`;
  cy.readMail({ subject });
});
`;

const READS = [
  { call: 'readMail', subject: '0.subject' },
  { call: 'this.inbox.latest', subject: 1 },
];

function readCorpus(t, email = { reads: READS }) {
  const dir = copyFixture(t, 'kite-club');
  const files = {
    'suite/e2e/reads.pw.ts': READ_SPEC,
    'web/cypress/e2e/reads.cy.ts': READ_CY,
    'web/cypress/support/commands.ts': READ_COMMANDS,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const config = JSON.parse(readFileSync(join(dir, 'kite.config.json'), 'utf8'));
  writeFileSync(join(dir, 'reads.config.json'), JSON.stringify({ ...config, ...(email ? { email } : {}) }, null, 2));
  const extracted = runCli(['extract', '--config', 'reads.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  return dir;
}

const factsIn = (dir, repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;

test('Test evidence AC-18: a configured read call gives one email read for each test that reaches it', (t) => {
  const dir = readCorpus(t);
  const suite = factsIn(dir, 'suite');
  const row = (fact) => [fact.test, fact.call, fact.subject, fact.reason ?? null, fact.where, fact.skipped];
  const reads = suite.filter((fact) => fact.type === 'email_read');
  assert.deepEqual(reads.map(row), [
    ['a literal subject', 'readMail', 'Welcome to the club', null, 'test', false],
    ['a template subject', 'readMail', 'Code * for *', null, 'test', false],
    ['a const subject', 'readMail', 'Your invite', null, 'test', false],
    ['a const subject', 'this.inbox.latest', 'Reset *', null, 'test', false],
    ['an unreadable subject', 'readMail', null, 'unreadable-subject', 'test', false],
    ['an unreadable subject', 'readMail', null, 'unreadable-subject', 'test', false],
    [null, 'readMail', 'Hello', null, 'test', false],
    ['a read through a hook and a helper', 'readMail', 'Welcome to the club', null, 'helper', false],
    ['a skipped read', 'readMail', 'Skipped', null, 'test', true],
  ]);
  const declared = new Map(suite.filter((fact) => fact.type === 'pw_test').map((fact) => [fact.line, fact]));
  for (const read of reads) {
    assert.ok(declared.has(read.testLine), `${read.test}: testLine names a test`);
    assert.equal(read.spec, 'e2e/reads.pw.ts');
  }
  assert.equal(declared.get(reads[6].testLine).test, 'TITLE', 'the test of a title that is not a literal');
  assert.deepEqual([reads[7].file, reads[7].line], ['e2e/reads.pw.ts', 6], 'the file and line of the call itself');

  const web = factsIn(dir, 'web').filter((fact) => fact.type === 'email_read');
  assert.deepEqual(
    web.map((fact) => [fact.spec, fact.test, fact.file, fact.subject, fact.where]),
    [
      ['e2e/reads.cy.ts', 'a cypress read', 'e2e/reads.cy.ts', 'Welcome to the club', 'test'],
      ['e2e/reads.cy.ts', null, 'support/commands.ts', 'Welcome *', 'helper'],
    ],
  );
  const cypressTests = factsIn(dir, 'web').filter((fact) => fact.type === 'cypress_test' && fact.spec === 'e2e/reads.cy.ts');
  assert.equal(web[0].testLine, cypressTests.find((fact) => fact.test === 'a cypress read').line);
  assert.equal(web[1].testLine, 6);
});

test('Test evidence AC-18: a subject is the value of its literal or of the one const the call sees', (t) => {
  const spec = [
    "import { test } from '@playwright/test';",
    '',
    "test('a const joined to a name', async () => {",
    "  const subject = 'Welcome ' + member;",
    '  await readMail({ subject });',
    '});',
    '',
    "test('a const beside an inner namesake', async () => {",
    "  const subject = 'Outer';",
    '  {',
    "    const subject = 'Inner';",
    '  }',
    '  await readMail({ subject });',
    '});',
    '',
    "test('a const behind a later inner namesake', async () => {",
    "  const subject = 'Outer';",
    '  if (ready) {',
    "    const subject = 'Inner';",
    '    await readMail({ subject });',
    '  }',
    '});',
    '',
    "test('escaped literals', async ({ page }) => {",
    '  await readMail({ subject: "Hello \\u0041" });',
    "  await readMail({ subject: `Tab\\tline ${code}` });",
    "  await readMail({ subject: 'It\\'s \\x41\\u{42}' });",
    "  await page.goto('/caf\\u00e9');",
    '});',
    '',
    "test('a key with a dollar sign', async () => {",
    "  await readDollar({ $subject: 'Welcome' });",
    "  await readDollar({ subject: 'Not this key' });",
    '});',
    '',
  ].join('\n');
  const dir = writeRepo(t, { 'suite/e2e/values.pw.ts': spec }, {
    repos: [{ id: 'suite', kind: 'playwright', root: 'suite' }],
    email: {
      reads: [
        { call: 'readMail', subject: '0.subject' },
        { call: 'readDollar', subject: '0.$subject' },
      ],
    },
  });
  const facts = extractRepoFacts(dir, 'suite');
  assert.deepEqual(
    facts.filter((fact) => fact.type === 'email_read').map((fact) => [fact.test, fact.call, fact.subject, fact.reason ?? null]),
    [
      ['a const joined to a name', 'readMail', null, 'unreadable-subject'],
      ['a const beside an inner namesake', 'readMail', 'Outer', null],
      ['a const behind a later inner namesake', 'readMail', 'Inner', null],
      ['escaped literals', 'readMail', 'Hello A', null],
      ['escaped literals', 'readMail', 'Tab\tline *', null],
      ['escaped literals', 'readMail', "It's AB", null],
      ['a key with a dollar sign', 'readDollar', 'Welcome', null],
      ['a key with a dollar sign', 'readDollar', null, 'unreadable-subject'],
    ],
  );
  assert.deepEqual(facts.filter((fact) => fact.type === 'pw_visit').map((fact) => fact.path), ['/café']);
});

test('Test evidence AC-18: the email key changes no fact but the email reads', (t) => {
  const withReads = readCorpus(t);
  const without = readCorpus(t, null);
  for (const repo of ['suite', 'web']) {
    const others = factsIn(withReads, repo).filter((fact) => fact.type !== 'email_read');
    assert.deepEqual(others, factsIn(without, repo), repo);
  }
});

const template = (code, channels) => `${JSON.stringify({ meta: { template: { code } }, channels }, null, 2)}\n`;
const emailChannel = (...sections) => ({ kind: 'email', sections });
const subjectSection = (text) => ({ role: 'subject', text });

test('Test evidence AC-19: an email template gives its id and its subject with each placeholder as a star', (t) => {
  const dir = writeRepo(
    t,
    {
      'mail/templates/welcome.json': template('club-welcome', [
        { kind: 'sms', sections: [subjectSection('Not this one')] },
        emailChannel({ role: 'body', text: 'Hi' }, subjectSection('Welcome to {{club}}, {{{member.name}}}')),
      ]),
      'mail/templates/nested/reset.json': template('club-reset', [emailChannel(subjectSection('Reset your code'))]),
      'mail/templates/no-email.json': template('club-sms', [{ kind: 'sms', sections: [subjectSection('Text only')] }]),
      'mail/templates/two-subjects.json': template('club-twice', [emailChannel(subjectSection('One'), subjectSection('Two'))]),
      'mail/templates/no-id.json': `${JSON.stringify({ meta: {}, channels: [emailChannel(subjectSection('Orphan'))] })}\n`,
      'mail/templates/broken.json': '{ "meta": ',
      'mail/other/ignored.json': template('club-ignored', [emailChannel(subjectSection('Ignored'))]),
    },
    {
      repos: [
        {
          id: 'mail',
          kind: 'email-templates',
          root: 'mail',
          templates: {
            files: ['templates/**/*.json'],
            id: 'meta.template.code',
            subject: 'channels[kind=email].sections[role=subject].text',
          },
        },
      ],
    },
  );
  const facts = extractRepoFacts(dir, 'mail');
  assert.deepEqual(
    facts.map((fact) => [fact.file, fact.id, fact.subject, fact.reason ?? null]),
    [
      ['templates/broken.json', null, null, 'unread-file'],
      ['templates/nested/reset.json', 'club-reset', 'Reset your code', null],
      ['templates/no-email.json', 'club-sms', null, 'subject-no-element'],
      ['templates/no-id.json', null, 'Orphan', 'id-no-element'],
      ['templates/two-subjects.json', 'club-twice', null, 'subject-two-elements'],
      ['templates/welcome.json', 'club-welcome', 'Welcome to *, *', null],
    ],
  );
  const welcome = facts.find((fact) => fact.id === 'club-welcome');
  const text = readFileSync(join(dir, 'mail', 'templates', 'welcome.json'), 'utf8');
  assert.equal(text.split('\n')[welcome.line - 1].includes('Welcome to {{club}}'), true, 'the line of the subject value');
});

const SENDERS_CS = `namespace Kite.Mail
{
    public class WelcomeEmail : EmailBase
    {
        public override string EmailCode => "club-welcome";
    }

    public class ResetEmail : EmailBase
    {
        public override string EmailCode { get; } = EmailCodes.Reset;
    }

    public class Outer
    {
        public class InviteEmail : EmailBase
        {
            public string EmailCode => EmailCodes.Invite;
        }
    }

    public class MissingEmail : EmailBase
    {
        public string EmailCode => EmailCodes.Missing;
    }

    public class TwiceEmail : EmailBase
    {
        public string EmailCode => Mail.Twice.Code;
    }

    public class Quiet
    {
        // public string EmailCode => "in a comment";
        public string OtherCode => "not configured";
    }
}
`;

const CODES_CS = `namespace Kite.Mail
{
    public static class EmailCodes
    {
        public const string Reset = "club-reset";
        public const string Invite = "club-invite";
    }

    public class Twice { public const string Code = "one"; }
}
`;

const TWICE_CS = `namespace Kite.Other
{
    public class Twice { public const string Code = "two"; }
}
`;

test('Test evidence AC-20: a configured sender member gives its email id, through a constant when it names one', (t) => {
  const dir = writeRepo(
    t,
    { 'api/Mail/Senders.cs': SENDERS_CS, 'api/Mail/EmailCodes.cs': CODES_CS, 'api/Other/Twice.cs': TWICE_CS },
    { email: { senders: [{ member: 'EmailCode' }] }, repos: [{ id: 'api', kind: 'backend', root: 'api', role: ['api'] }] },
  );
  const senders = extractRepoFacts(dir, 'api').filter((fact) => fact.type === 'email_sender');
  assert.deepEqual(
    senders.map((fact) => [fact.class, fact.member, fact.id, fact.constant ?? null, fact.reason ?? null, fact.line]),
    [
      ['WelcomeEmail', 'EmailCode', 'club-welcome', null, null, 5],
      ['MissingEmail', 'EmailCode', null, 'EmailCodes.Missing', 'no-constant', 23],
      ['TwiceEmail', 'EmailCode', null, 'Twice.Code', 'two-constants', 28],
      ['InviteEmail', 'EmailCode', 'club-invite', 'EmailCodes.Invite', null, 17],
      ['ResetEmail', 'EmailCode', 'club-reset', 'EmailCodes.Reset', null, 10],
    ].sort((a, b) => a[5] - b[5]),
  );

  const plain = writeRepo(
    t,
    { 'api/Mail/Senders.cs': SENDERS_CS, 'api/Mail/EmailCodes.cs': CODES_CS, 'api/Other/Twice.cs': TWICE_CS },
    { repos: [{ id: 'api', kind: 'backend', root: 'api', role: ['api'] }] },
  );
  const without = extractRepoFacts(plain, 'api');
  assert.deepEqual(without.filter((fact) => fact.type === 'email_sender'), []);
  assert.deepEqual(
    extractRepoFacts(dir, 'api').filter((fact) => fact.type !== 'email_sender'),
    without,
    'senders add their facts and change no other',
  );
});

test('Test evidence AC-20: a sender id is the value of its C# literal, in each literal form', (t) => {
  const senders = [
    'namespace Club.Mail;',
    'public class VerbatimEmail { public string EmailCode => @"club\\welcome ""vip"""; }',
    'public class EscapedEmail { public string EmailCode => "club-\\x41\\u0042\\t"; }',
    'public class RawEmail { public string EmailCode => """club "raw" id"""; }',
    'public class ConstVerbatimEmail { public string EmailCode => Codes.Verbatim; }',
    'public class ConstRawEmail { public string EmailCode { get; } = Codes.Raw; }',
    '',
  ].join('\n');
  const codes = [
    'namespace Club.Mail;',
    'public static class Codes',
    '{',
    '    public const string Verbatim = @"club\\path";',
    '    public const string Raw = """club-raw""";',
    '}',
    '',
  ].join('\n');
  const dir = writeRepo(
    t,
    { 'api/Mail/Senders.cs': senders, 'api/Mail/Codes.cs': codes },
    { email: { senders: [{ member: 'EmailCode' }] }, repos: [{ id: 'api', kind: 'backend', root: 'api', role: ['api'] }] },
  );
  const found = extractRepoFacts(dir, 'api').filter((fact) => fact.type === 'email_sender');
  assert.deepEqual(
    found.map((fact) => [fact.class, fact.id, fact.reason ?? null]),
    [
      ['VerbatimEmail', 'club\\welcome "vip"', null],
      ['EscapedEmail', 'club-AB\t', null],
      ['RawEmail', 'club "raw" id', null],
      ['ConstVerbatimEmail', 'club\\path', null],
      ['ConstRawEmail', 'club-raw', null],
    ],
  );
});

const LINK_SPEC = `import { test } from '@playwright/test';

test('a linked read', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: \`You joined \${club}\` });
});

test('a read whose template has two senders', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: \`Welcome to \${club}\` });
});

test('a read whose template has no sender', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: \`Reset \${code}\` });
});

test('a read that two templates match', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: \`Invite \${code}\` });
});

test('a read with no subject', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: subjectFor('join') });
});

test('a read that no template matches', async ({ request }) => {
  await request.post('/clubs/v1/join/c1');
  await readMail({ subject: 'Goodbye' });
});

test('a read outside the area whose sender the route walk reaches', async () => {
  await readMail({ subject: \`You joined \${club}\` });
});

test('a read outside the area', async () => {
  await readMail({ subject: \`Welcome to \${club}\` });
});
`;

const LINK_SENDERS = `namespace Kite.Mail
{
    public class WelcomeEmail
    {
        public string EmailCode => "club-welcome";
    }

    public class WelcomeAgainEmail
    {
        public string EmailCode => "club-welcome";
    }
}
`;

const mailTemplate = (code, subject) => template(code, [emailChannel(subjectSection(subject))]);

function linkCorpus(t) {
  const dir = copyFixture(t, 'kite-club');
  const controller = join(dir, 'backend', 'src', 'Controllers', 'ClubsController.cs');
  writeFileSync(
    controller,
    readFileSync(controller, 'utf8').replace(
      '    public class ClubsController : ControllerBase\n    {\n',
      '    public class ClubsController : ControllerBase\n    {\n        public string EmailCode => "club-join";\n\n',
    ),
  );
  const files = {
    'suite/e2e/links.pw.ts': LINK_SPEC,
    'backend/src/Mail/Welcome.cs': LINK_SENDERS,
    'mail/templates/join.json': mailTemplate('club-join', 'You joined {{club}}'),
    'mail/templates/welcome.json': mailTemplate('club-welcome', 'Welcome to {{club}}'),
    'mail/templates/welcome-kites.json': mailTemplate('club-welcome-kites', 'Welcome to Kites'),
    'mail/templates/reset.json': mailTemplate('club-reset', 'Reset {{{code}}}'),
    'mail/templates/invite-a.json': mailTemplate('club-invite-a', 'Invite {{code}}'),
    'mail/templates/invite-b.json': mailTemplate('club-invite-b', 'Invite {{token}}'),
    'links.area.txt': 'POST clubs/v1/join/*\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const config = JSON.parse(readFileSync(join(dir, 'kite.config.json'), 'utf8'));
  config.repos.push({ id: 'mail', kind: 'email-templates', root: 'mail', templates: { ...TEMPLATES, id: 'meta.template.code' } });
  config.email = { reads: [{ call: 'readMail', subject: '0.subject' }], senders: [{ member: 'EmailCode' }] };
  writeFileSync(join(dir, 'links.config.json'), JSON.stringify(config, null, 2));
  const extracted = runCli(['extract', '--config', 'links.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  return dir;
}

function linkCover(dir, format = '--json') {
  const result = runCli(['cover', '--area', 'links.area.txt', ...(format ? [format] : []), '--config', 'links.config.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return format === '--json' ? JSON.parse(result.stdout) : result.stdout;
}

test('Test evidence AC-21: cover links each area email read to one template and one sender, or says why not', (t) => {
  const dir = linkCorpus(t);
  const report = linkCover(dir);
  const ROUTE_KEY = 'POST clubs/v1/join/*';
  assert.deepEqual(
    report.emails.entries.map((email) => [
      email.test,
      email.state,
      email.template ? email.template.id : null,
      email.sender ? `${email.sender.class}.${email.sender.member}` : null,
      (email.candidates || []).map((candidate) => candidate.id ?? candidate.class),
      email.routes,
      email.senderRoutes,
    ]),
    [
      ['a linked read', 'linked', 'club-join', 'ClubsController.EmailCode', [], [ROUTE_KEY], [ROUTE_KEY]],
      ['a read whose template has two senders', 'ambiguous-sender', 'club-welcome', null, ['WelcomeEmail', 'WelcomeAgainEmail'], [ROUTE_KEY], []],
      ['a read whose template has no sender', 'no-sender', 'club-reset', null, [], [ROUTE_KEY], []],
      ['a read that two templates match', 'ambiguous-template', null, null, ['club-invite-a', 'club-invite-b'], [ROUTE_KEY], []],
      ['a read with no subject', 'no-subject', null, null, [], [ROUTE_KEY], []],
      ['a read that no template matches', 'no-template', null, null, [], [ROUTE_KEY], []],
      ['a read outside the area whose sender the route walk reaches', 'linked', 'club-join', 'ClubsController.EmailCode', [], [], [ROUTE_KEY]],
    ],
  );
  assert.equal(report.emails.outsideArea, 1);
  assert.equal(
    report.emails.entries[1].template.subject,
    'Welcome to *',
    'the narrower template "Welcome to Kites" does not take a read of "Welcome to *"',
  );

  const shape = (route) => ({ key: route.key, state: route.state, levels: route.levels, parity: route.parity, evidence: route.evidence });
  const factsDir = join(dir, 'out', 'facts');
  for (const repo of ['suite', 'api', 'mail']) {
    const path = join(factsDir, `${repo}.json`);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.facts = document.facts.filter((fact) => !fact.type.startsWith('email_'));
    writeFileSync(path, JSON.stringify(document));
  }
  const without = linkCover(dir);
  assert.deepEqual(without.routes.map(shape), report.routes.map(shape));
  assert.deepEqual(without.totals, report.totals);
  assert.deepEqual(without.emails, { entries: [], outsideArea: 0 });
});

test('Test evidence AC-21: a read of a test that an environment guard skips, or whose guard is unknown, is skipped', (t) => {
  const dir = linkCorpus(t);
  const states = { 'a linked read': 'environment-skip', 'a read that no template matches': 'unknown' };
  const path = join(dir, 'out', 'facts', 'suite.json');
  const document = JSON.parse(readFileSync(path, 'utf8'));
  document.facts = document.facts.map((fact) =>
    fact.type === 'pw_test' && states[fact.test] ? { ...fact, eligibility: states[fact.test], skipped: false } : fact,
  );
  writeFileSync(path, JSON.stringify(document));
  const skipped = linkCover(dir).emails.entries.filter((email) => email.skipped).map((email) => email.test);
  assert.deepEqual(skipped, ['a linked read', 'a read that no template matches']);
});

test('Test evidence AC-21: the reports label an email link as a static match, not proof of delivery', (t) => {
  const dir = linkCorpus(t);
  const text = linkCover(dir, null);
  assert.match(text, /\nemails {2}7 read in the area · 1 outside · a link is a static match, not proof of delivery\n/);
  assert.match(text, /e2e\/links\.pw\.ts :: a linked read \(5\) — readMail "You joined \*" — linked · template club-join/);
  const md = join(dir, 'cover.md');
  const written = runCli(['cover', '--area', 'links.area.txt', '--md', md, '--config', 'links.config.json'], { cwd: dir });
  assert.equal(written.status, 0, written.stderr);
  assert.match(readFileSync(md, 'utf8'), /## Email reads\n\n7 read in the area, 1 outside it\. A link from a read to a template and a sender is a static match, not proof of delivery\./);
});

test('Test evidence AC-21: a read pattern star matches only a template star', async () => {
  const { subjectMatches } = await import('../lib/emails.js');
  assert.equal(subjectMatches('Welcome to *', 'Welcome to *'), true);
  assert.equal(subjectMatches('Welcome to *', 'Welcome to Kites'), true);
  assert.equal(subjectMatches('* *', 'Reset *'), true);
  assert.equal(subjectMatches('Welcome to Kites', 'Welcome to *'), false);
  assert.equal(subjectMatches('Reset * now', 'Reset *'), false);
  assert.equal(subjectMatches('Cost (*)', 'Cost (12)'), true);
});

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../lib/config.js';
import { factIdentity, validateFacts } from '../lib/facts.js';
import { copyFixture, runCli } from './helpers.js';

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

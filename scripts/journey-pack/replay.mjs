/**
 * Replay: answer a ledger's runs from a promoted bundle and project the answers. A replay
 * never extracts, never runs an application test and never consults a code index: it copies
 * the bundle, writes the snapshot's fact sets back as fact files, lets the tool check them
 * against the snapshot, runs `trace` for each distinct run, and closes with a second
 * `join --snapshot` whose fact sets must equal the bundle's — the tool's own evidence that
 * nothing it read was rebuilt or rewritten.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MANIFEST_FORMAT, MANIFEST_SCHEMA_VERSION, REFUSED, Refusal, derivedConfig, factSetIdentityOf, readPointer, runTool, stripList, writeJsonAtomic } from './capture.mjs';
import {
  PINNED_ENVIRONMENT,
  codeIndexConfigured,
  configIdentity,
  contentIdentity,
  leaksPath,
  makeScrubber,
  canonicalJson,
  sameKnown,
  sha256,
  missingIdentity,
  toolIdentity,
} from './identity.mjs';
import { LedgerError, anchorProblems, readLedger } from './ledger.mjs';
import {
  carryClassifications,
  classificationProblems,
  driftedCases,
  project,
  report,
  serialise,
} from './projection.mjs';

export const DRIFT = 1;
export const USAGE = 2;

// The header fields a materialised fact file carries, in the order the tool writes them.
const HEADER_FIELDS = ['repo', 'kind', 'generatedFrom', 'headSha', 'dirty', 'fileCount', 'dirtyDigest', 'titles', 'provider'];

function materialise(set) {
  const header = {};
  for (const field of HEADER_FIELDS) if (set[field] !== undefined && set[field] !== null) header[field] = set[field];
  header.facts = set.facts;
  return header;
}

function runKey(run) {
  return JSON.stringify([run.start, run.args]);
}

/**
 * Replay `options.cases` from `options.bundle`. `options.expect` compares against a committed
 * projection; `options.write` rewrites one. Returns `{ exit, diagnostics, projection }`.
 */
export function replay(options) {
  const harnessRoot = resolve(options.harnessRoot);
  const configFile = resolve(options.config);
  const configDir = dirname(configFile);
  const bundleRoot = resolve(options.bundle);
  const ledgerFile = resolve(options.cases);
  const outDir = resolve(options.out);
  const env = options.env ?? process.env;
  const diagnostics = [];
  const invocations = [];
  const work = mkdtempSync(join(tmpdir(), 'flowtrace-journey-replay-'));
  const scrub = makeScrubber([
    ['<tool>', harnessRoot],
    ['<config>', configDir],
    ['<bundle>', bundleRoot],
    ['<replay>', work],
    ['<out>', outDir],
  ]);
  mkdirSync(join(outDir, 'raw'), { recursive: true });
  let manifest = {
    format: MANIFEST_FORMAT,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    step: 'replay',
    result: 'refused',
    node: process.version,
    environment: { ...PINNED_ENVIRONMENT },
    invocations,
    diagnostics,
  };

  const call = (verb, args) => {
    const result = runTool(harnessRoot, [verb, ...args], { cwd: work, env });
    invocations.push({
      verb,
      args: args.map((arg) => scrub(arg)),
      exit: result.exit,
      stderr: result.stderr.split('\n').filter((line) => line.trim() !== '').map((line) => scrub(line)),
    });
    return result;
  };

  const writeManifest = () => {
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (leaksPath(text)) {
      diagnostics.push({ name: 'manifest-path-leak', repo: null, detail: 'the replay manifest still names a machine path after scrubbing' });
      manifest = { ...manifest, result: 'refused', invocations: [], diagnostics };
      writeJsonAtomic(join(outDir, 'replay.json'), manifest);
      return false;
    }
    writeFileSync(join(outDir, 'replay.json'), text);
    return true;
  };

  try {
    const ledgerInvalid = (error) => {
      if (!(error instanceof LedgerError)) throw error;
      diagnostics.push({ name: 'ledger-invalid', repo: null, detail: scrub(error.message) });
      writeManifest();
      return { exit: USAGE, diagnostics, projection: null };
    };
    let ledger;
    try {
      ledger = readLedger(ledgerFile);
      // Sites are anchored against the ledger's own configuration; replaying them against
      // another one would compare an answer about one tree with expectations about another.
      if (resolve(dirname(ledgerFile), ledger.config) !== configFile) {
        throw new LedgerError([`the ledger names another configuration (${ledger.config}) than the one replayed`]);
      }
    } catch (error) {
      return ledgerInvalid(error);
    }

    const pointer = readPointer(bundleRoot);
    if (!pointer || !existsSync(join(bundleRoot, pointer.current, 'snapshot.json'))) {
      throw new Refusal('bundle-missing', 'the bundle has no promoted generation');
    }
    const bundle = join(work, 'bundle');
    let snapshotBytes;
    let captured;
    try {
      cpSync(join(bundleRoot, pointer.current), bundle, { recursive: true });
      snapshotBytes = readFileSync(join(bundle, 'snapshot.json'));
      captured = readFileSync(join(bundle, 'capture.json'), 'utf8');
    } catch (error) {
      throw new Refusal('bundle-missing', `the promoted generation cannot be read (${error.code ?? 'error'})`);
    }
    try {
      captured = JSON.parse(captured);
    } catch {
      throw new Refusal('bundle-mismatch', 'the capture manifest of the promoted generation is not valid JSON');
    }
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
      throw new Refusal('bundle-mismatch', 'the capture manifest of the promoted generation is not an object');
    }
    manifest.bundle = { generation: pointer.current, captureSha256: sha256(readFileSync(join(bundle, 'capture.json'))) };
    manifest.snapshot = { format: captured.snapshot?.format, schemaVersion: captured.snapshot?.schemaVersion, sha256: sha256(snapshotBytes) };
    // Every later read assumes this manifest's layout; one of another format or version could
    // name the same fields with other meanings, so it is refused before any of them is read.
    const header = [
      ['format', MANIFEST_FORMAT],
      ['schemaVersion', MANIFEST_SCHEMA_VERSION],
      ['step', 'capture'],
      ['result', 'promoted'],
    ].filter(([field, expected]) => captured[field] !== expected);
    if (header.length > 0) {
      throw new Refusal(
        'bundle-mismatch',
        `the capture manifest is not a promoted ${MANIFEST_FORMAT} capture of schema version ${MANIFEST_SCHEMA_VERSION}: ${header.map(([field]) => field).join(', ')}`,
      );
    }

    const { invocations: _invocations, diagnostics: _diagnostics, ...identity } = captured;
    const unknown = missingIdentity(identity);
    if (unknown.length > 0) throw new Refusal('identity-unknown', unknown.join(', '));

    if (captured.snapshot.sha256 !== sha256(snapshotBytes)) {
      throw new Refusal('bundle-mismatch', 'the snapshot bytes do not match the capture manifest that promoted them');
    }
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotBytes.toString('utf8'));
    } catch {
      throw new Refusal('bundle-mismatch', 'the snapshot of the promoted generation is not valid JSON');
    }
    const headerMoved = ['format', 'schemaVersion'].filter((field) => snapshot?.[field] !== captured.snapshot[field]);
    if (headerMoved.length > 0) {
      throw new Refusal('bundle-mismatch', `the snapshot header differs from the capture manifest: ${headerMoved.map((field) => `snapshot.${field}`).join(', ')}`);
    }
    const bundleSets = new Map((Array.isArray(snapshot.factSets) ? snapshot.factSets : []).map((set) => [set.repo, set]));
    const entries = new Map();
    for (const entry of captured.repositories) {
      if (entries.has(entry.id)) {
        throw new Refusal('bundle-mismatch', `repositories: ${entry.id} appears more than once in the capture manifest`, entry.id);
      }
      entries.set(entry.id, entry);
    }
    const uncovered = [...bundleSets.keys()].filter((repo) => !entries.has(repo));
    if (uncovered.length > 0) throw new Refusal('identity-unknown', uncovered.map((repo) => `repositories[${repo}]`).join(', '));
    for (const entry of captured.repositories) {
      const set = bundleSets.get(entry.id);
      if (!set || canonicalJson(factSetIdentityOf(set)) !== canonicalJson(entry.factSet)) {
        throw new Refusal('bundle-mismatch', `the fact set of ${entry.id} is not the one its capture recorded`, entry.id);
      }
    }

    const { raw, identity: config } = configIdentity(configFile);
    manifest.config = config;
    if (!sameKnown(config.digest, captured.config.digest)) {
      throw new Refusal('config-changed-since-capture', 'the configuration digest differs from the one captured');
    }
    const repos = (raw.repos || []).map((repo) => ({ repo, root: resolve(configDir, repo.root) }));
    const content = new Map();
    for (const { repo, root } of repos) {
      if (!existsSync(root)) throw new Refusal('source-unavailable', `the root of ${repo.id} is not present`, repo.id);
      const now = contentIdentity(repo, root);
      content.set(repo.id, stripList(now));
      const then = entries.get(repo.id);
      if (!then || !sameKnown(now.digest, then.content?.digest)) {
        throw new Refusal('source-changed-since-capture', `the content of ${repo.id} differs from the captured content`, repo.id);
      }
    }

    try {
      const anchors = anchorProblems(ledgerFile, ledger);
      if (anchors.length > 0) throw new LedgerError(anchors);
    } catch (error) {
      return ledgerInvalid(error);
    }

    const factsDir = join(work, 'out', 'facts');
    mkdirSync(factsDir, { recursive: true });
    for (const set of snapshot.factSets || []) {
      writeFileSync(join(factsDir, `${set.repo}.json`), `${JSON.stringify(materialise(set), null, 2)}\n`);
    }
    const replayConfig = join(work, 'replay.config.json');
    writeFileSync(replayConfig, `${JSON.stringify(derivedConfig(raw, configDir, join(work, 'out'), { dropCodeIndex: true }), null, 2)}\n`);

    const checked = call('join', ['--config', replayConfig, '--against', join(bundle, 'snapshot.json')]);
    if (checked.exit === 4) {
      const digest = /do not match their recorded digest/.test(checked.stderr);
      throw new Refusal(digest ? 'facts-digest-mismatch' : 'snapshot-refused', scrub(checked.stderr.trim().split('\n').pop() ?? ''));
    }
    if (checked.exit !== 0) throw new Refusal('join-failed', `join --against exited ${checked.exit}`);

    const outputs = new Map();
    const byKey = new Map();
    for (const run of ledger.runs) {
      const key = runKey(run);
      if (!byKey.has(key)) {
        const output = call('trace', [run.start, ...run.args, '--json', '--config', replayConfig]);
        byKey.set(key, output);
      }
      const output = byKey.get(key);
      outputs.set(run.id, output);
      writeFileSync(join(outDir, 'raw', `${run.id}.json`), output.stdout);
      writeFileSync(join(outDir, 'raw', `${run.id}.stderr.txt`), scrub(output.stderr));
    }

    const endFile = join(work, 'end-snapshot.json');
    const closed = call('join', ['--config', replayConfig, '--snapshot', endFile]);
    if (closed.exit !== 0) throw new Refusal('join-failed', `closing join --snapshot exited ${closed.exit}`);
    const end = JSON.parse(readFileSync(endFile, 'utf8'));
    const moved = [];
    const endSets = new Map((end.factSets || []).map((set) => [set.repo, set]));
    for (const [repo, set] of bundleSets) if (canonicalJson(endSets.get(repo)) !== canonicalJson(set)) moved.push(repo);
    if (endSets.size !== bundleSets.size) moved.push('(fact set count)');
    if (canonicalJson(end.config) !== canonicalJson(snapshot.config)) moved.push('(configuration)');
    const tool = toolIdentity(harnessRoot);
    manifest.tool = {
      generatedFrom: end.tool && end.tool.version ? `flowtrace ${end.tool.version}` : 'unknown',
      checkoutHead: tool.checkoutHead,
      sourceDigest: tool.sourceDigest,
    };
    manifest.repositories = repos.map(({ repo }) => ({
      id: repo.id,
      kind: repo.kind,
      root: config.roots[repo.id],
      factSet: {
        before: bundleSets.has(repo.id) ? factSetIdentityOf(bundleSets.get(repo.id)) : 'unknown',
        after: endSets.has(repo.id) ? factSetIdentityOf(endSets.get(repo.id)) : 'unknown',
      },
      content: content.get(repo.id),
    }));
    manifest.codeIndex = { state: 'absent', configured: codeIndexConfigured(raw, env) };
    if (moved.length > 0) throw new Refusal('facts-changed-during-replay', `fact sets differ after the replay: ${moved.join(', ')}`);

    let projection = project(ledger, outputs);
    let exit = 0;
    let previous = null;
    const committedFile = options.expect ?? options.write ?? null;
    if (committedFile && existsSync(committedFile)) {
      try {
        previous = JSON.parse(readFileSync(committedFile, 'utf8'));
      } catch {
        previous = null;
      }
    }
    projection = carryClassifications(projection, previous);
    if (options.expect) {
      const drifted = driftedCases(projection, previous);
      if (drifted.length > 0) {
        diagnostics.push({ name: 'projection-drift', repo: null, detail: drifted.join(', ') });
        exit = DRIFT;
      } else {
        const problems = classificationProblems(projection, ledger.vocabulary);
        if (problems.length > 0) {
          diagnostics.push({ name: 'classification-inconsistent', repo: null, detail: problems.join('; ') });
          exit = DRIFT;
        }
      }
    }
    if (options.write) writeFileSync(options.write, serialise(projection));
    writeFileSync(join(outDir, 'projection.json'), serialise(projection));
    const text = report(projection, { generation: pointer.current, tool: manifest.tool.generatedFrom });
    writeFileSync(join(outDir, 'report.txt'), text);
    manifest.result = 'replayed';
    if (!writeManifest()) return { exit: REFUSED, diagnostics, projection, report: text };
    return { exit, diagnostics, projection, report: text };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    diagnostics.push({ ...error.diagnostic, detail: scrub(error.diagnostic.detail) });
    manifest.result = 'refused';
    writeManifest();
    return { exit: REFUSED, diagnostics, projection: null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

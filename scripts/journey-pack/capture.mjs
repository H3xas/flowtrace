/**
 * Capture: extract a configuration's repositories into a staging directory, take one
 * `join --snapshot` of the result, and promote it to an immutable bundle generation only when
 * no source it could have read changed while it ran.
 *
 * Bundle root layout: `current` (the one promotion pointer), immutable `g-…` generation
 * directories holding `snapshot.json` and `capture.json`, and transient `capture.lock`,
 * `.staging-*` and `current.tmp-*` entries that only a lock holder creates or removes. Every
 * rename stays inside the bundle root, so each is atomic; anything that stops before the
 * pointer is replaced leaves `current` and every generation exactly as they were.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  PINNED_ENVIRONMENT,
  childEnvironment,
  codeIndexConfigured,
  configIdentity,
  contentIdentity,
  leaksPath,
  makeScrubber,
  sha256,
  toolIdentity,
  witness,
  witnessChanges,
  witnessRoots,
} from './identity.mjs';

export const MANIFEST_FORMAT = 'flowtrace-journey-manifest';
export const MANIFEST_SCHEMA_VERSION = 1;
export const REFUSED = 3;

/** A refusal the harness names; it always exits `REFUSED` with this diagnostic. */
export class Refusal extends Error {
  constructor(name, detail, repo = null) {
    super(`${name}: ${detail}`);
    this.diagnostic = { name, repo, detail };
  }
}

export function writeJsonAtomic(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Take the capture lock. A lock left by a process on this host that no longer runs is
 * reclaimed once; a live holder, or a holder on another host whose liveness cannot be
 * checked from here, is a refusal rather than a wait.
 */
function acquireLock(bundleRoot) {
  const lock = join(bundleRoot, 'capture.lock');
  const body = JSON.stringify({ pid: process.pid, host: hostname() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lock, `${body}\n`, { flag: 'wx' });
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(lock, 'utf8'));
    } catch {
      holder = null;
    }
    const stale = holder && holder.host === hostname() && !pidAlive(holder.pid);
    if (!stale || attempt > 0) {
      const who = holder ? `pid ${holder.pid} on ${holder.host === hostname() ? 'this host' : 'another host'}` : 'an unreadable holder';
      throw new Refusal('capture-in-progress', `the bundle is locked by ${who}`);
    }
    rmSync(lock, { force: true });
  }
  throw new Refusal('capture-in-progress', 'the lock could not be taken');
}

function sweepTransient(bundleRoot) {
  for (const name of readdirSync(bundleRoot)) {
    if (name.startsWith('.staging-') || name.startsWith('current.tmp-')) {
      rmSync(join(bundleRoot, name), { recursive: true, force: true });
    }
  }
}

export function readPointer(bundleRoot) {
  const pointer = join(bundleRoot, 'current');
  if (!existsSync(pointer)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointer, 'utf8'));
    return parsed && typeof parsed.current === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Runs the tool exactly as a user would, under the pinned environment. */
export function runTool(harnessRoot, args, { cwd, env = process.env } = {}) {
  const run = spawnSync(process.execPath, [join(harnessRoot, 'bin', 'flowtrace.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnvironment(env),
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return { exit: run.status === null ? 128 : run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** The configuration a capture or replay hands flowtrace: same content, absolute paths, own `out`. */
export function derivedConfig(raw, configDir, out, { dropCodeIndex = false } = {}) {
  const config = structuredClone(raw);
  config.out = out;
  for (const repo of config.repos || []) {
    if (typeof repo.root === 'string') repo.root = resolve(configDir, repo.root);
    if (repo.factsProvider && typeof repo.factsProvider.file === 'string') {
      repo.factsProvider.file = resolve(configDir, repo.factsProvider.file);
    }
    if (dropCodeIndex) delete repo.scout;
  }
  if (dropCodeIndex) delete config.scout;
  return config;
}

export function stripList(content) {
  const { list, ...rest } = content;
  return rest;
}

export function factSetIdentityOf(set) {
  const { facts, ...identity } = set;
  return identity;
}

/**
 * Capture `options.config` into `options.bundle`. Returns `{ exit, diagnostics, generation }`;
 * a refusal exits 3 with its diagnostic and, for a refusal after the lock was taken, a
 * `refused-capture.json` manifest in the bundle root. An unexpected error or an interruption
 * leaves no refusal manifest and no promoted change, only whatever the next capture sweeps.
 */
export function capture(options, hooks = {}) {
  const harnessRoot = resolve(options.harnessRoot);
  const configFile = resolve(options.config);
  const configDir = dirname(configFile);
  const bundleRoot = resolve(options.bundle);
  const env = options.env ?? process.env;
  mkdirSync(bundleRoot, { recursive: true });

  const invocations = [];
  const diagnostics = [];
  let staging = null;
  let lock = null;
  let scrub = makeScrubber([['<tool>', harnessRoot], ['<config>', configDir], ['<bundle>', bundleRoot]]);
  let manifest = null;

  const call = (verb, args, cwd) => {
    const result = runTool(harnessRoot, [verb, ...args], { cwd, env });
    invocations.push({
      verb,
      args: args.map((arg) => scrub(arg)),
      exit: result.exit,
      stderr: result.stderr.split('\n').filter((line) => line.trim() !== '').map((line) => scrub(line)),
    });
    return result;
  };

  try {
    lock = acquireLock(bundleRoot);
    sweepTransient(bundleRoot);

    const { raw, identity: config } = configIdentity(configFile);
    const repos = (raw.repos || []).map((repo) => ({ repo, root: resolve(configDir, repo.root) }));
    for (const { repo } of repos) {
      const file = repo.factsProvider && repo.factsProvider.file;
      if (typeof file === 'string' && !existsSync(resolve(configDir, file))) {
        throw new Refusal('provider-document-missing', `repository ${repo.id} names a facts provider document that does not exist`, repo.id);
      }
    }

    const before = repos.map(({ repo, root }) => ({
      content: contentIdentity(repo, root),
      witness: witness(witnessRoots(repo, root)),
    }));
    if (hooks.afterBeforeDigest) hooks.afterBeforeDigest();

    staging = join(bundleRoot, `.staging-${process.pid}-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(staging, 'gen'), { recursive: true });
    scrub = makeScrubber([['<tool>', harnessRoot], ['<config>', configDir], ['<staging>', staging], ['<bundle>', bundleRoot]]);
    const stagedConfig = join(staging, 'capture.config.json');
    writeFileSync(stagedConfig, `${JSON.stringify(derivedConfig(raw, configDir, join(staging, 'out')), null, 2)}\n`);

    const extracted = call('extract', ['--config', stagedConfig], staging);
    if (extracted.exit !== 0) throw new Refusal('extract-failed', `extract exited ${extracted.exit}`);
    if (hooks.afterExtract) hooks.afterExtract();
    const snapshotFile = join(staging, 'gen', 'snapshot.json');
    const joined = call('join', ['--config', stagedConfig, '--snapshot', snapshotFile], staging);
    if (joined.exit !== 0) throw new Refusal('join-failed', `join exited ${joined.exit}`);

    const after = repos.map(({ repo, root }) => ({
      content: contentIdentity(repo, root),
      witness: witness(witnessRoots(repo, root)),
    }));
    const contentMoved = repos.filter((_, index) => before[index].content.digest !== after[index].content.digest);
    if (contentMoved.length > 0) {
      throw new Refusal(
        'capture-source-changed',
        `source changed while it was captured: ${contentMoved.map(({ repo }) => repo.id).join(', ')}`,
        contentMoved[0].repo.id,
      );
    }
    const written = repos
      .map(({ repo }, index) => ({ repo, changed: witnessChanges(before[index].witness, after[index].witness) }))
      .filter((entry) => entry.changed.length > 0);
    if (written.length > 0) {
      throw new Refusal(
        'source-written-during-capture',
        written.map((entry) => `${entry.repo.id}: ${entry.changed.join(', ')}`).join('; '),
        written[0].repo.id,
      );
    }

    const snapshotBytes = readFileSync(snapshotFile);
    const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
    const setsById = new Map((snapshot.factSets || []).map((set) => [set.repo, set]));
    for (const set of snapshot.factSets || []) {
      if (set.titles && set.titles.status === 'failed') {
        throw new Refusal('titles-collector-failed', `repository ${set.repo}: ${scrub(set.titles.reason ?? 'no reason recorded')}`, set.repo);
      }
    }

    const tool = toolIdentity(harnessRoot);
    manifest = {
      format: MANIFEST_FORMAT,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      step: 'capture',
      result: 'promoted',
      tool: {
        generatedFrom: snapshot.tool && snapshot.tool.version ? `flowtrace ${snapshot.tool.version}` : 'unknown',
        checkoutHead: tool.checkoutHead,
        sourceDigest: tool.sourceDigest,
      },
      node: process.version,
      environment: { ...PINNED_ENVIRONMENT },
      snapshot: { format: snapshot.format, schemaVersion: snapshot.schemaVersion, sha256: sha256(snapshotBytes) },
      config,
      repositories: repos.map(({ repo }, index) => {
        const set = setsById.get(repo.id);
        return {
          id: repo.id,
          kind: repo.kind,
          root: config.roots[repo.id],
          factSet: set ? factSetIdentityOf(set) : 'unknown',
          content: stripList(before[index].content),
          witness: { before: before[index].witness.digest, after: after[index].witness.digest },
        };
      }),
      codeIndex: { state: 'absent', configured: codeIndexConfigured(raw, env) },
      invocations,
      diagnostics,
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (leaksPath(text)) throw new Refusal('manifest-path-leak', 'the capture manifest still names a machine path after scrubbing');
    writeFileSync(join(staging, 'gen', 'capture.json'), text);

    if (hooks.beforePromote) hooks.beforePromote();
    const generation = `g-${sha256(snapshotBytes).slice(0, 16)}-${sha256(text).slice(0, 8)}`;
    const target = join(bundleRoot, generation);
    if (existsSync(target)) {
      const same =
        readFileSync(join(target, 'snapshot.json')).equals(snapshotBytes) &&
        readFileSync(join(target, 'capture.json'), 'utf8') === text;
      if (!same) throw new Error(`generation ${generation} exists with different bytes`);
    } else {
      renameSync(join(staging, 'gen'), target);
    }
    const previous = readPointer(bundleRoot);
    const pointer = {
      current: generation,
      previous: previous && previous.current !== generation ? previous.current : (previous?.previous ?? null),
    };
    const temporary = join(bundleRoot, `current.tmp-${process.pid}`);
    writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`);
    renameSync(temporary, join(bundleRoot, 'current'));

    for (const name of readdirSync(bundleRoot)) {
      if (name.startsWith('g-') && name !== pointer.current && name !== pointer.previous) {
        rmSync(join(bundleRoot, name), { recursive: true, force: true });
      }
    }
    return { exit: 0, diagnostics, generation };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    diagnostics.push({ ...error.diagnostic, detail: scrub(error.diagnostic.detail) });
    if (lock) {
      const refused = {
        format: MANIFEST_FORMAT,
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        step: 'capture',
        result: 'refused',
        node: process.version,
        environment: { ...PINNED_ENVIRONMENT },
        invocations,
        diagnostics,
      };
      if (!leaksPath(JSON.stringify(refused))) writeJsonAtomic(join(bundleRoot, 'refused-capture.json'), refused);
    }
    return { exit: REFUSED, diagnostics, generation: null };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (lock) rmSync(lock, { force: true });
  }
}

#!/usr/bin/env node
/**
 * Build a Node.js single-executable-application (SEA) binary for the
 * current platform. No CLI arguments: platform and architecture are
 * inferred from the running Node process, output goes to dist/.
 *
 * Steps:
 *   1. Bundle bin/flowtrace.js and its local (relative) imports into one
 *      self-contained CommonJS file. Node's SEA feature only supports a
 *      CommonJS main script, and a truly standalone binary cannot rely on
 *      sibling files being present on disk at runtime, so any first-party
 *      ESM module graph has to be flattened first. The bundler below is a
 *      deliberately small, dependency-free implementation of the common
 *      ESM subset (named/default/namespace import and export, relative
 *      specifiers, node: builtins, import.meta.url). It throws a clear
 *      error on anything outside that subset rather than emitting broken
 *      output; see the "Bundler limitations" comment further down.
 *   2. Ask Node to turn that single file into a SEA blob.
 *   3. Copy the current `node` executable and inject the blob into it
 *      with postject (fetched on demand via npx; not a project
 *      dependency).
 *   4. On macOS, remove and reapply an ad-hoc code signature around the
 *      injection step, as required by Node's SEA docs.
 *   5. Start the binary once with `--help`. A bundle that cannot load
 *      crashes every command, so a binary that does not exit 0 here fails
 *      the build before anything signs or uploads it.
 *
 * No npm dependency is required except `postject`, invoked through `npx`
 * at build time only. Importing this file builds nothing: the steps run
 * only when it is the process entry point.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'flowtrace.js');
const DIST_DIR = join(ROOT, 'dist');
const BUNDLE_PATH = join(DIST_DIR, 'bundle.cjs');
const SEA_CONFIG_PATH = join(ROOT, 'sea-config.json');
const BLOB_PATH = join(DIST_DIR, 'sea-prep.blob');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const START_TIMEOUT_MS = 60_000;

function log(message) {
  console.log(`[build-sea] ${message}`);
}

/** A path as a message shows it: relative to the checkout when it lies inside it. */
function shown(path) {
  const rel = relative(ROOT, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

// A `/` after one of these words opens a regex literal, as it does after an operator or an
// opening bracket. After a name, a number, a literal or a closing bracket it divides. That
// is the one guess a scanner without a parser makes; a source that defeats it shows up as a
// bundle whose export names differ from the module's own.
const REGEX_AFTER_WORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
  'typeof', 'void', 'yield',
]);
const WORD_CHAR = /[\w$\u0080-￿]/;

/**
 * A copy of `src` in which comment text and the contents of strings, template literals and
 * regex literals are spaces, with every offset and line break kept and the code inside
 * `${…}` kept as code. Imports and exports are matched on this copy, so text that only
 * spells one, such as a doc comment's example, is never rewritten. A comment or literal
 * that does not close throws: a bundle built from a source the scanner misread would carry
 * exports nothing declares.
 */
function maskSource(src, filePath) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const unclosed = (kind, at) =>
    new Error(
      `Unreadable source ${shown(filePath)}: ${kind} opened at line ${src.slice(0, at).split('\n').length} is not closed`,
    );
  const substitutions = []; // each open `${`: braces opened inside it, where it and its template start
  let regexAllowed = true;

  // Template text from `from` to the closing backtick or the next `${`; returns where code resumes.
  const templateText = (from, open) => {
    let j = from;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\') {
        blank(j, j + 2);
        j += 2;
      } else if (ch === '`') {
        regexAllowed = false;
        return j + 1;
      } else if (ch === '$' && src[j + 1] === '{') {
        substitutions.push({ braces: 0, template: open, at: j });
        regexAllowed = true;
        return j + 2;
      } else {
        blank(j, j + 1);
        j += 1;
      }
    }
    throw unclosed('template literal', open);
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw unclosed('block comment', i);
      blank(i, end + 2);
      i = end + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (src[j] !== ch) {
        if (j >= src.length || src[j] === '\n') throw unclosed('string', i);
        j += src[j] === '\\' ? 2 : 1;
      }
      blank(i + 1, j);
      regexAllowed = false;
      i = j + 1;
    } else if (ch === '`') {
      i = templateText(i + 1, i);
    } else if (ch === '/' && regexAllowed) {
      let j = i + 1;
      let inClass = false;
      while (inClass || src[j] !== '/') {
        if (j >= src.length || src[j] === '\n') throw unclosed('regex literal', i);
        if (src[j] === '\\') {
          if (src[j + 1] === '\n') throw unclosed('regex literal', i);
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      while (i < src.length && WORD_CHAR.test(src[i])) i += 1; // flags
      regexAllowed = false;
    } else if (ch === '}' && substitutions.length > 0 && substitutions.at(-1).braces === 0) {
      i = templateText(i + 1, substitutions.pop().template);
    } else if (WORD_CHAR.test(ch)) {
      let j = i + 1;
      while (j < src.length && WORD_CHAR.test(src[j])) j += 1;
      regexAllowed = REGEX_AFTER_WORDS.has(src.slice(i, j));
      i = j;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else {
      if (substitutions.length > 0) {
        if (ch === '{') substitutions.at(-1).braces += 1;
        else if (ch === '}') substitutions.at(-1).braces -= 1;
      }
      regexAllowed = ch !== ')' && ch !== ']' && ch !== '}';
      i += 1;
    }
  }
  if (substitutions.length > 0) throw unclosed('${…} expression', substitutions.at(-1).at);
  return out.join('');
}

/**
 * `src` with each match of `pattern` (flags `d` and `g`) in its code replaced by what
 * `replace(match, text)` returns. The pattern runs over the masked copy, so a match never
 * starts inside a comment or a literal. `match` holds the masked groups, in which a comment
 * is spaces; `text(k)` is group k read from the real source, which a specifier needs because
 * the masked copy holds only spaces inside a string.
 */
function rewriteCode(src, filePath, pattern, replace) {
  const masked = maskSource(src, filePath);
  let out = '';
  let last = 0;
  for (const match of masked.matchAll(pattern)) {
    const text = (k) => (match.indices[k] ? src.slice(match.indices[k][0], match.indices[k][1]) : undefined);
    out += src.slice(last, match.index) + replace(match, text);
    last = match.index + match[0].length;
  }
  return out + src.slice(last);
}

function isLocalSpecifier(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

function resolveLocalModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = extname(base)
    ? [base]
    : [`${base}.js`, `${base}.mjs`, join(base, 'index.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(
    `Cannot resolve local import "${spec}" from ${shown(fromFile)}`,
  );
}

function parseImportClause(clause) {
  const trimmed = clause.trim();
  let m;
  if ((m = trimmed.match(/^([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)$/))) {
    return { defaultName: m[1], namespaceName: m[2], namedList: null };
  }
  if ((m = trimmed.match(/^([\w$]+)\s*,\s*\{([\s\S]*)\}$/))) {
    return { defaultName: m[1], namespaceName: null, namedList: m[2] };
  }
  if ((m = trimmed.match(/^\*\s+as\s+([\w$]+)$/))) {
    return { defaultName: null, namespaceName: m[1], namedList: null };
  }
  if ((m = trimmed.match(/^\{([\s\S]*)\}$/))) {
    return { defaultName: null, namespaceName: null, namedList: m[1] };
  }
  if ((m = trimmed.match(/^([\w$]+)$/))) {
    return { defaultName: m[1], namespaceName: null, namedList: null };
  }
  throw new Error(`Unsupported import clause: "${clause}"`);
}

function parseNamedList(namedList) {
  return namedList
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      return m ? { imported: m[1], local: m[2] } : { imported: part, local: part };
    });
}

/**
 * Bindings for an import that closes a cycle — module A importing from module B while
 * B is still being bundled. A flattened bundle initialises modules in dependency order,
 * so the back-edge's module object does not exist yet at the importing module's own
 * initialisation time; real ESM survives this because a function declaration is hoisted
 * and a binding is live. These forwarders reproduce that for the only shape a cycle can
 * legitimately take here: a function called later, never a value read at import time.
 * A hoisted `function` declaration, so order inside the wrapper does not matter either.
 */
function lazyBindings(named, childVar) {
  return named
    .map(
      ({ imported, local }) =>
        `function ${local}(...args) { return ${childVar}[${JSON.stringify(imported)}](...args); }`,
    )
    .join('\n');
}

function destructureExpr(named) {
  return named
    .map((n) => (n.imported === n.local ? n.local : `${n.imported}: ${n.local}`))
    .join(', ');
}

/**
 * Rewrites `export ...` declarations to plain declarations, recording
 * each exported binding so it can be attached to `module.exports` at the
 * end of the module wrapper.
 *
 * Bundler limitations (throws rather than mis-bundling):
 *   - `export * from '...'` and `export { a } from '...'` (re-export from
 *     another module) are not supported.
 *   - `import` and `export` count only in code: the same words in a
 *     comment, a string, a template literal or a regex literal are text
 *     (see `maskSource`). An import is recognised at the start of a line.
 *   - `export default <anonymous expression>` is only supported for the
 *     named-function, named-class, and bare-identifier forms.
 *   - multi-declarator exports (`export const a = 1, b = 2;`) are not
 *     supported; export one binding per statement.
 */
function transformExports(src, filePath) {
  const exportNames = [];
  const declaration = (exported) => (match, text) => {
    exportNames.push({ local: match[2], exported: exported ?? match[2] });
    return text(1);
  };

  const code = maskSource(src, filePath);
  if (/^export\s*\*/m.test(code)) {
    throw new Error('Unsupported "export * from ..." syntax');
  }
  if (/^export\s*\{[^}]*\}\s*from\s*['"]/m.test(code)) {
    throw new Error('Unsupported "export { ... } from ..." re-export syntax');
  }

  src = rewriteCode(
    src,
    filePath,
    /export\s+default\s+((?:async\s+)?function\*?\s+([\w$]+)\s*\()/dg,
    declaration('default'),
  );
  src = rewriteCode(src, filePath, /export\s+default\s+(class\s+([\w$]+))/dg, declaration('default'));
  src = rewriteCode(src, filePath, /export\s+default\s+([\w$]+)\s*;/dg, (match) => {
    exportNames.push({ local: match[1], exported: 'default' });
    return '';
  });
  if (/export\s+default\s+/.test(maskSource(src, filePath))) {
    throw new Error(
      'Unsupported "export default" form (only named function/class or a bare identifier re-export are supported)',
    );
  }

  src = rewriteCode(src, filePath, /export\s+((?:async\s+)?function\*?\s+([\w$]+))/dg, declaration());
  src = rewriteCode(src, filePath, /export\s+(class\s+([\w$]+))/dg, declaration());
  src = rewriteCode(src, filePath, /export\s+((?:const|let|var)\s+([\w$]+)\s*=)/dg, declaration());
  src = rewriteCode(src, filePath, /export\s*\{([^}]*)\}\s*;?/dg, (match) => {
    for (const part of match[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const am = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (am) exportNames.push({ local: am[1], exported: am[2] });
      else exportNames.push({ local: part, exported: part });
    }
    return '';
  });

  if (/(^|\n)\s*export\s/.test(maskSource(src, filePath))) {
    throw new Error(
      'Unsupported export syntax remains after transform (multi-declarator export?)',
    );
  }

  return { src, exportNames };
}

const bundled = new Map(); // resolved path -> module var name
const bundleOrder = []; // completed wrapper source strings, dependency-first
let moduleCounter = 0;
const inProgress = new Set();
const moduleExports = []; // { path, exports } per completed module, dependency-first

// A checkout made with core.autocrlf (the default on Windows) hands the bundler CRLF
// sources. Every match below anchors on "\n" -- the shebang strip, the import and export
// rewrites -- so normalise once on read. The bundle is written with LF on every platform.
function readSource(filePath) {
  return readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

/**
 * `src` with `import.meta.url` and every import statement rewritten: a local module is
 * bundled and bound from its module object, anything else is required. The entry and the
 * modules it reaches share this, so both read imports the same way.
 */
function rewriteImports(src, filePath) {
  src = rewriteCode(src, filePath, /import\.meta\.url/dg, () => "require('node:url').pathToFileURL(__filename).toString()");

  // Side-effect-only imports: `import '<spec>';`
  src = rewriteCode(src, filePath, /^import\s*['"]([^'"]+)['"]\s*;?/dgm, (_match, text) => {
    const spec = text(1);
    if (isLocalSpecifier(spec)) {
      bundleModule(resolveLocalModule(filePath, spec));
      return '';
    }
    return `require(${JSON.stringify(spec)});`;
  });

  // Value/binding imports: `import <clause> from '<spec>';`
  return rewriteCode(
    src,
    filePath,
    /^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]\s*;?/dgm,
    (match, text) => {
      const spec = text(2);
      const { defaultName, namespaceName, namedList } = parseImportClause(match[1]);
      const lines = [];
      if (isLocalSpecifier(spec)) {
        const { varName: childVar, cyclic } = bundleModule(resolveLocalModule(filePath, spec));
        if (cyclic && (namespaceName || defaultName)) {
          throw new Error(
            `Unsupported cyclic import: ${shown(filePath)} imports ${namespaceName ? 'a namespace' : 'a default'} from ${spec} while that module is still initialising. Import named functions instead.`,
          );
        }
        if (namespaceName) lines.push(`const ${namespaceName} = ${childVar};`);
        if (defaultName) lines.push(`const ${defaultName} = ${childVar}.default;`);
        if (namedList) {
          const named = parseNamedList(namedList);
          lines.push(
            cyclic ? lazyBindings(named, childVar) : `const { ${destructureExpr(named)} } = ${childVar};`,
          );
        }
      } else {
        if (namespaceName) lines.push(`const ${namespaceName} = require(${JSON.stringify(spec)});`);
        if (defaultName) lines.push(`const ${defaultName} = require(${JSON.stringify(spec)});`);
        if (namedList) {
          const named = parseNamedList(namedList);
          lines.push(`const { ${destructureExpr(named)} } = require(${JSON.stringify(spec)});`);
        }
      }
      return lines.join('\n');
    },
  );
}

function bundleModule(filePath) {
  const existing = bundled.get(filePath);
  if (existing) return { varName: existing, cyclic: inProgress.has(filePath) };

  const varName = `__mod_${moduleCounter++}`;
  bundled.set(filePath, varName); // set before recursing to guard against cycles
  inProgress.add(filePath);
  const src = rewriteImports(readSource(filePath), filePath);
  const { src: bodySrc, exportNames } = transformExports(src, filePath);
  moduleExports.push({ path: filePath, exports: exportNames.map(({ exported }) => exported) });

  const exportLines = exportNames
    .map(({ local, exported }) => `  module.exports[${JSON.stringify(exported)}] = ${local};`)
    .join('\n');

  const wrapper = [
    `const ${varName} = (function () {`,
    `  const module = { exports: {} };`,
    bodySrc,
    exportLines,
    `  return module.exports;`,
    `})();`,
  ].join('\n');

  inProgress.delete(filePath);
  bundleOrder.push(wrapper);
  return { varName, cyclic: false };
}

/**
 * Bundles `entryPath` and the local modules it imports into one CommonJS file at
 * `bundlePath`, and returns each inlined module with the export names the bundle attaches
 * to it. A bundle left by an earlier run is removed first, so a run that throws leaves no
 * file that reads as its own output.
 */
export function bundle(entryPath, bundlePath) {
  rmSync(bundlePath, { force: true });
  if (!existsSync(entryPath)) {
    throw new Error(
      `Entry point not found: ${shown(entryPath)}. Run the build from the repository root.`,
    );
  }
  bundled.clear();
  bundleOrder.length = 0;
  moduleCounter = 0;
  inProgress.clear();
  moduleExports.length = 0;

  let src = readSource(entryPath);
  src = src.replace(/^#!.*\n/, ''); // drop the shebang; not valid mid-file
  src = rewriteImports(src, entryPath);

  const { src: bodySrc } = transformExports(src, entryPath); // entry exports (if any) are discarded; nothing imports the CLI itself

  const bundleText = [
    '#!/usr/bin/env node',
    "'use strict';",
    '// Generated by scripts/build-sea.mjs. Do not edit by hand.',
    ...bundleOrder,
    bodySrc,
  ].join('\n\n');

  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, bundleText);

  // Fail fast on a bundler bug rather than handing SEA a broken file.
  execFileSync(process.execPath, ['--check', bundlePath], { stdio: 'inherit' });
  return { modules: moduleExports.map((m) => ({ path: m.path, exports: [...m.exports] })) };
}

function writeSeaConfig() {
  const config = {
    main: relative(ROOT, BUNDLE_PATH),
    output: relative(ROOT, BLOB_PATH),
    disableExperimentalSEAWarning: true,
  };
  writeFileSync(SEA_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  log(`Wrote ${relative(ROOT, SEA_CONFIG_PATH)}`);
}

function generateBlob() {
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  log(`Generated SEA blob -> ${relative(ROOT, BLOB_PATH)}`);
}

function platformNames() {
  const osNames = { darwin: 'macos', linux: 'linux', win32: 'windows' };
  const osName = osNames[process.platform] ?? process.platform;
  const arch = process.arch;
  const ext = process.platform === 'win32' ? '.exe' : '';
  return { osName, arch, ext };
}

function createBinary() {
  const { osName, arch, ext } = platformNames();
  const outPath = join(DIST_DIR, `flowtrace-${osName}-${arch}${ext}`);

  copyFileSync(process.execPath, outPath);
  if (process.platform !== 'win32') chmodSync(outPath, 0o755);

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' });
  }
  if (process.platform === 'win32') {
    // A signed executable needs its signature removed before injection. This is
    // best-effort because signtool may be absent and unsigned executables need no
    // removal.
    try {
      execFileSync('signtool', ['remove', '/s', outPath], { stdio: 'inherit' });
    } catch {
      log('signtool not available or node executable unsigned; continuing without signature removal');
    }
  }

  const postjectArgs = [
    'postject',
    outPath,
    'NODE_SEA_BLOB',
    relative(ROOT, BLOB_PATH),
    '--sentinel-fuse',
    SEA_FUSE,
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  // `npx` resolves the postject CLI on demand; it is not a project
  // dependency and this is the only network access this script needs.
  execFileSync('npx', ['--yes', ...postjectArgs], { cwd: ROOT, stdio: 'inherit', shell: true });

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', outPath], { stdio: 'inherit' });
  }

  log(`Built ${relative(ROOT, outPath)}`);
  return outPath;
}

/**
 * Runs `executable --help` and throws unless it exits 0 within `timeoutMs`. Building,
 * signing and uploading a binary says nothing about whether it starts, and a bundle that
 * cannot load fails on every command, `--help` included.
 */
export function startCheck(executable, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const result = spawnSync(executable, ['--help'], { encoding: 'utf8', timeout: timeoutMs });
  let reason = null;
  if (result.error?.code === 'ETIMEDOUT') reason = `it ran past ${timeoutMs / 1000} s`;
  else if (result.error) reason = `it could not be run (${result.error.message})`;
  else if (result.signal) reason = `it was ended by ${result.signal}`;
  else if (result.status !== 0) reason = `it exited ${result.status}`;
  if (reason) {
    throw new Error(
      `Built binary ${shown(executable)} did not start with --help: ${reason}.\n${result.stderr ?? ''}`.trimEnd(),
    );
  }
}

function cleanup() {
  for (const p of [SEA_CONFIG_PATH, BUNDLE_PATH, BLOB_PATH]) {
    rmSync(p, { force: true });
  }
}

function main() {
  const { modules } = bundle(ENTRY, BUNDLE_PATH);
  log(`Bundled ${relative(ROOT, ENTRY)} -> ${relative(ROOT, BUNDLE_PATH)} (${modules.length} local module(s) inlined)`);
  writeSeaConfig();
  generateBlob();
  const outPath = createBinary();
  startCheck(outPath);
  log(`Started ${relative(ROOT, outPath)} --help`);
  cleanup();
  log(`Done: ${relative(ROOT, outPath)}`);
}

/**
 * Whether this file was invoked as the process's entry point, however the path to it was
 * spelled. A checkout reached through a symlinked directory spells that path differently
 * from the module's own resolved location, and a guard that compared the two spellings
 * would build nothing and exit zero.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const physical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return physical(resolve(process.argv[1])) === physical(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) main();

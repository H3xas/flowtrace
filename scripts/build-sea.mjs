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
 *
 * No npm dependency is required except `postject`, invoked through `npx`
 * at build time only.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'flowtrace.js');
const DIST_DIR = join(ROOT, 'dist');
const BUNDLE_PATH = join(DIST_DIR, 'bundle.cjs');
const SEA_CONFIG_PATH = join(ROOT, 'sea-config.json');
const BLOB_PATH = join(DIST_DIR, 'sea-prep.blob');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(message) {
  console.log(`[build-sea] ${message}`);
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
    `Cannot resolve local import "${spec}" from ${relative(ROOT, fromFile)}`,
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
 *   - `import`/`export` are recognised in statement position only — at the
 *     start of a line. A module that emits spec source of its own therefore
 *     keeps its generated `import` lines intact instead of having them
 *     rewritten to `require` calls.
 *   - `export default <anonymous expression>` is only supported for the
 *     named-function, named-class, and bare-identifier forms.
 *   - multi-declarator exports (`export const a = 1, b = 2;`) are not
 *     supported; export one binding per statement.
 */
function transformExports(src) {
  const exportNames = [];

  if (/^export\s*\*/m.test(src)) {
    throw new Error('Unsupported "export * from ..." syntax');
  }
  if (/^export\s*\{[^}]*\}\s*from\s*['"]/m.test(src)) {
    throw new Error('Unsupported "export { ... } from ..." re-export syntax');
  }

  src = src.replace(
    /export\s+default\s+((?:async\s+)?function\*?\s+([\w$]+)\s*\()/g,
    (_m, decl, name) => {
      exportNames.push({ local: name, exported: 'default' });
      return decl;
    },
  );
  src = src.replace(
    /export\s+default\s+(class\s+([\w$]+))/g,
    (_m, decl, name) => {
      exportNames.push({ local: name, exported: 'default' });
      return decl;
    },
  );
  src = src.replace(/export\s+default\s+([\w$]+)\s*;/g, (_m, name) => {
    exportNames.push({ local: name, exported: 'default' });
    return '';
  });
  if (/export\s+default\s+/.test(src)) {
    throw new Error(
      'Unsupported "export default" form (only named function/class or a bare identifier re-export are supported)',
    );
  }

  src = src.replace(
    /export\s+((?:async\s+)?function\*?\s+([\w$]+))/g,
    (_m, decl, name) => {
      exportNames.push({ local: name, exported: name });
      return decl;
    },
  );
  src = src.replace(/export\s+(class\s+([\w$]+))/g, (_m, decl, name) => {
    exportNames.push({ local: name, exported: name });
    return decl;
  });
  src = src.replace(
    /export\s+((?:const|let|var)\s+([\w$]+)\s*=)/g,
    (_m, decl, name) => {
      exportNames.push({ local: name, exported: name });
      return decl;
    },
  );
  src = src.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, list) => {
    for (const part of list.split(',').map((s) => s.trim()).filter(Boolean)) {
      const am = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (am) exportNames.push({ local: am[1], exported: am[2] });
      else exportNames.push({ local: part, exported: part });
    }
    return '';
  });

  if (/(^|\n)\s*export\s/.test(src)) {
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

function bundleModule(filePath) {
  const existing = bundled.get(filePath);
  if (existing) return { varName: existing, cyclic: inProgress.has(filePath) };

  const varName = `__mod_${moduleCounter++}`;
  bundled.set(filePath, varName); // set before recursing to guard against cycles
  inProgress.add(filePath);
  let src = readFileSync(filePath, 'utf8');

  src = src.replace(/import\.meta\.url/g, "require('node:url').pathToFileURL(__filename).toString()");

  // Side-effect-only imports: `import '<spec>';`
  src = src.replace(/^import\s*['"]([^'"]+)['"]\s*;?/gm, (_m, spec) => {
    if (isLocalSpecifier(spec)) {
      bundleModule(resolveLocalModule(filePath, spec));
      return '';
    }
    return `require(${JSON.stringify(spec)});`;
  });

  // Value/binding imports: `import <clause> from '<spec>';`
  src = src.replace(
    /^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_m, clause, spec) => {
      const { defaultName, namespaceName, namedList } = parseImportClause(clause);
      const lines = [];
      if (isLocalSpecifier(spec)) {
        const { varName: childVar, cyclic } = bundleModule(resolveLocalModule(filePath, spec));
        if (cyclic && (namespaceName || defaultName)) {
          throw new Error(
            `Unsupported cyclic import: ${relative(ROOT, filePath)} imports ${namespaceName ? 'a namespace' : 'a default'} from ${spec} while that module is still initialising. Import named functions instead.`,
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

  const { src: bodySrc, exportNames } = transformExports(src);

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

function bundleEntry() {
  if (!existsSync(ENTRY)) {
    throw new Error(
      `Entry point not found: ${relative(ROOT, ENTRY)}. Run the build from the repository root.`,
    );
  }

  let src = readFileSync(ENTRY, 'utf8');
  src = src.replace(/^#!.*\n/, ''); // drop the shebang; not valid mid-file
  src = src.replace(/import\.meta\.url/g, "require('node:url').pathToFileURL(__filename).toString()");

  src = src.replace(/^import\s*['"]([^'"]+)['"]\s*;?/gm, (_m, spec) => {
    if (isLocalSpecifier(spec)) {
      bundleModule(resolveLocalModule(ENTRY, spec));
      return '';
    }
    return `require(${JSON.stringify(spec)});`;
  });

  src = src.replace(
    /^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
    (_m, clause, spec) => {
      const { defaultName, namespaceName, namedList } = parseImportClause(clause);
      const lines = [];
      if (isLocalSpecifier(spec)) {
        const { varName: childVar } = bundleModule(resolveLocalModule(ENTRY, spec));
        if (namespaceName) lines.push(`const ${namespaceName} = ${childVar};`);
        if (defaultName) lines.push(`const ${defaultName} = ${childVar}.default;`);
        if (namedList) {
          const named = parseNamedList(namedList);
          lines.push(`const { ${destructureExpr(named)} } = ${childVar};`);
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

  const { src: bodySrc } = transformExports(src); // entry exports (if any) are discarded; nothing imports the CLI itself

  const bundleText = [
    '#!/usr/bin/env node',
    "'use strict';",
    '// Generated by scripts/build-sea.mjs. Do not edit by hand.',
    ...bundleOrder,
    bodySrc,
  ].join('\n\n');

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(BUNDLE_PATH, bundleText);
  log(`Bundled ${relative(ROOT, ENTRY)} -> ${relative(ROOT, BUNDLE_PATH)} (${bundled.size} local module(s) inlined)`);

  // Fail fast on a bundler bug rather than handing SEA a broken file.
  execFileSync(process.execPath, ['--check', BUNDLE_PATH], { stdio: 'inherit' });
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

function cleanup() {
  for (const p of [SEA_CONFIG_PATH, BUNDLE_PATH, BLOB_PATH]) {
    rmSync(p, { force: true });
  }
}

function main() {
  bundleEntry();
  writeSeaConfig();
  generateBlob();
  const outPath = createBinary();
  cleanup();
  log(`Done: ${relative(ROOT, outPath)}`);
}

main();

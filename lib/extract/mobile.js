/**
 * Ionic/Angular mobile feature extractor.
 *
 * Heuristic, regex-and-bracket-matching reader over Angular/Ionic TypeScript, HTML
 * templates, and Cypress specs. It does not parse TypeScript; it recognises the idioms
 * this feature uses for component/service wiring, GatewayService HTTP calls, template
 * event bindings, method bodies, and Cypress network interception, turning each
 * occurrence into one fact (see `lib/facts.js` for the fact shapes). The NgRx idioms —
 * `store.dispatch(action(…))`, `createEffect(() => this.actions$.pipe(ofType(action), …))`
 * and an exported `const action = createAction(…)` — are read as their own fact types, because
 * the HTTP call a component triggers lives in the effect, never in the handler.
 */

import { readFileSync, existsSync } from 'node:fs';
import { relative, dirname, resolve as resolvePath, join as joinPath, basename } from 'node:path';
import { walk } from '../walk.js';
import { fact } from '../facts.js';
import {
  bestPartial,
  blankComments,
  escapeRegExp,
  findLocalConst,
  flattenInterpolations,
  fullLiteral,
  makeLineFinder,
  matchBalanced,
  skipString,
  skipTemplate,
  splitArgs,
  splitPlus,
  toRelative,
} from './text.js';

const FEATURE_SUBPATH = 'src/app/features';
const CYPRESS_E2E_SUBPATH = 'cypress/e2e';
const CYPRESS_SUPPORT_SUBPATH = 'cypress/support';

/**
 * Every `.ts` source root the extractor walks, repository-relative. The default is the
 * feature path below; `options.featureRoots` may list other feature areas. Each root gets
 * its own `walk()` call, and all results feed the shared `facts` and `classInfos` arrays,
 * so a template in one root can resolve a `renders` edge to a selector in another.
 */
const DEFAULT_FEATURE_ROOTS = [FEATURE_SUBPATH];

const DEFAULT_TS_EXCLUDE = ['private_node_modules', '*.spec.ts'];

const GATEWAY_VERBS = ['get', 'post', 'put', 'delete', 'patch'];
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const GATEWAY_TYPE = 'GatewayService';
const EFFECT_SOURCE_TYPE = 'Actions';

const MODIFIER_KEYWORDS = 'public|private|protected|static|async|readonly|abstract|override|get|set';
const MEMBER_HEAD_RE = new RegExp(
  '[ \\t\\r\\n]*(?:@[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?[ \\t\\r\\n]*)*' +
    `(?:(?:${MODIFIER_KEYWORDS})\\s+)*` +
    '(\\*\\s*)?([A-Za-z_$][\\w$]*)\\s*(<[^>(]*>)?\\s*\\(',
  'yd',
);
const ARROW_HEAD_RE = new RegExp(
  '[ \\t\\r\\n]*(?:@[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?[ \\t\\r\\n]*)*' +
    `(?:(?:${MODIFIER_KEYWORDS})\\s+)*` +
    '([A-Za-z_$][\\w$]*)\\s*!?\\s*(?::[^=;{}]+)?=\\s*(?:async\\s+)?',
  'yd',
);
const EFFECT_HEAD_RE = new RegExp(
  '[ \\t\\r\\n]*((?:@[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?[ \\t\\r\\n]*)*)' +
    `(?:(?:${MODIFIER_KEYWORDS})\\s+)*` +
    '([A-Za-z_$][\\w$]*)\\s*!?\\s*(?::[^=;{}]+)?=\\s*',
  'yd',
);
const PARAM_RE = /^(?:(?:private|protected|public|readonly)\s+)+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/;
const INJECT_FIELD_RE =
  /(?:public|private|protected|readonly)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]+)?=\s*inject\(\s*([A-Za-z_$][\w$]*)/g;
const BODY_CALL_RE =
  /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)\s*)?(?:<[^<>()]*>\s*)?\(/g;

const DISPATCH_RE = /\bdispatch\s*\(/g;
const OF_TYPE_RE = /\bofType\s*(?:<[^<>()]*>\s*)?\(/g;
const ACTION_DEF_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]+)?=\s*createAction\s*\(/g;

const EVENT_BINDING_RE = /(?<=[\s>])\(([A-Za-z_$][\w$.-]*)\)\s*=\s*(["'])([\s\S]*?)\2/g;
const HANDLER_CALL_RE = /(?:\bthis\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
const HANDLER_ASSIGN_RE = /^\s*(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*=\s*(?!=)/;
const TEMPLATE_NON_HANDLERS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'new', '$any']);

/**
 * Entry point: repoRoot is the mobile client project checkout. Every per-file parse
 * failure is contained so one malformed source file cannot abort the whole extraction.
 */
export async function extract(repoRoot, options = {}) {
  const extraExclude = Array.isArray(options.exclude) ? options.exclude : [];
  const tsExclude = [...DEFAULT_TS_EXCLUDE, ...extraExclude];
  const cypress = options.cypress && typeof options.cypress === 'object' ? options.cypress : {};
  const cypressE2eSubpath = cypress.e2e ?? CYPRESS_E2E_SUBPATH;
  const cypressSupportSubpath = cypress.support ?? CYPRESS_SUPPORT_SUBPATH;

  const facts = [];
  const classInfos = [];

  const featureRoots =
    Array.isArray(options.featureRoots) && options.featureRoots.length > 0
      ? options.featureRoots
      : DEFAULT_FEATURE_ROOTS;
  for (const featureSubpath of featureRoots) {
    const featureRoot = joinPath(repoRoot, featureSubpath);
    if (!existsSync(featureRoot)) continue;
    const tsFiles = walk(featureRoot, { extensions: ['.ts'], exclude: tsExclude });
    for (const absPath of tsFiles) {
      try {
        processTsFile(repoRoot, absPath, facts, classInfos);
      } catch {
        continueExtraction();
      }
    }
  }

  const selectorMap = new Map();
  for (const entry of facts) {
    if (entry.type === 'component' && entry.selector && entry.selector.includes('-')) {
      selectorMap.set(entry.selector, entry.name);
    }
  }
  for (const info of classInfos) {
    try {
      processRenders(repoRoot, info, selectorMap, facts);
    } catch {
      continueExtraction();
    }
  }

  for (const [subpath, isE2e] of [[cypressE2eSubpath, true], [cypressSupportSubpath, false]]) {
    const root = joinPath(repoRoot, subpath);
    if (!existsSync(root)) continue;
    const specFiles = walk(root, { extensions: ['.ts'], exclude: extraExclude });
    for (const absPath of specFiles) {
      try {
        processCypressFile(repoRoot, absPath, facts, isE2e);
      } catch {
        continueExtraction();
      }
    }
  }

  return facts;
}

function continueExtraction() {}

/** Class-body member splitting. */

function splitClassMembers(text, bodyStart, bodyEnd) {
  const members = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipString(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 || nl > bodyEnd ? bodyEnd : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? bodyEnd : end + 2;
      continue;
    }
    const effect = readEffectMember(text, i, bodyEnd);
    if (effect) {
      members.push(effect);
      i = effect.bodyEnd + 1;
      continue;
    }
    MEMBER_HEAD_RE.lastIndex = i;
    const m = MEMBER_HEAD_RE.exec(text);
    if (m && m.index === i) {
      const name = m[2];
      const nameIndex = m.indices[2][0];
      const parenOpen = i + m[0].length - 1;
      const parenClose = matchBalanced(text, parenOpen);
      if (parenClose === -1) {
        i += 1;
        continue;
      }
      let j = parenClose + 1;
      let braceIdx = -1;
      while (j < bodyEnd) {
        const c = text[j];
        if (c === "'" || c === '"') {
          j = skipString(text, j, c);
          continue;
        }
        if (c === '`') {
          j = skipTemplate(text, j);
          continue;
        }
        if (c === '{') {
          braceIdx = j;
          break;
        }
        if (c === ';') break;
        j += 1;
      }
      if (braceIdx !== -1) {
        const closeBrace = matchBalanced(text, braceIdx);
        if (closeBrace === -1) {
          i = bodyEnd;
          continue;
        }
        members.push({ name, nameIndex, parenOpen, parenClose, bodyStart: braceIdx + 1, bodyEnd: closeBrace });
        i = closeBrace + 1;
        continue;
      }
      i = j + 1;
      continue;
    }
    const arrow = readArrowMember(text, i, bodyEnd);
    if (arrow) {
      members.push(arrow);
      i = arrow.bodyEnd + 1;
      continue;
    }
    if (ch === '{') {
      const close = matchBalanced(text, i);
      i = close === -1 ? bodyEnd : close + 1;
      continue;
    }
    i += 1;
  }
  return members;
}

function statementEnd(text, start, limit) {
  let i = start;
  let depth = 0;
  while (i < limit) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipString(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return i;
    i += 1;
  }
  return limit;
}

/**
 * An NgRx effect field is a method body the walk must be able to enter: the service call a
 * dispatched action reaches is written inside it, not in the component that dispatched.
 * Both forms are recognised — `field$ = createEffect(...)`, whose body is the call's
 * argument list, and the legacy `@Effect() field$ = this.actions$.pipe(...)`, whose body
 * runs to the end of the statement. The parameter range is left empty because an effect
 * takes none, so a URL builder is never inlined from it.
 */
function readEffectMember(text, index, bodyEnd) {
  EFFECT_HEAD_RE.lastIndex = index;
  const head = EFFECT_HEAD_RE.exec(text);
  if (!head || head.index !== index) return null;
  const decorators = head[1] || '';
  const name = head[2];
  const nameIndex = head.indices[2][0];
  const empty = nameIndex + name.length;
  let pos = index + head[0].length;

  if (text.startsWith('createEffect', pos)) {
    pos += 'createEffect'.length;
    while (pos < bodyEnd && /\s/.test(text[pos])) pos += 1;
    if (text[pos] !== '(') return null;
    const close = matchBalanced(text, pos);
    if (close === -1) return null;
    return { name, nameIndex, parenOpen: empty, parenClose: empty, bodyStart: pos + 1, bodyEnd: close, effect: true };
  }
  if (/@Effect\b/.test(decorators)) {
    return {
      name,
      nameIndex,
      parenOpen: empty,
      parenClose: empty,
      bodyStart: pos,
      bodyEnd: statementEnd(text, pos, bodyEnd),
      effect: true,
    };
  }
  return null;
}

/**
 * A class field holding an arrow function is a method for every purpose this extractor
 * has: it owns a body, it can be named by a template binding, and it can call a service.
 * Both body forms are recognised — a braced block and a single expression.
 */
function readArrowMember(text, index, bodyEnd) {
  ARROW_HEAD_RE.lastIndex = index;
  const head = ARROW_HEAD_RE.exec(text);
  if (!head || head.index !== index) return null;
  const name = head[1];
  const nameIndex = head.indices[1][0];
  let pos = index + head[0].length;
  let parenOpen;
  let parenClose;
  if (text[pos] === '(') {
    parenOpen = pos;
    parenClose = matchBalanced(text, pos);
    if (parenClose === -1) return null;
    pos = parenClose + 1;
  } else {
    const param = /^[A-Za-z_$][\w$]*/.exec(text.slice(pos, pos + 128));
    if (!param) return null;
    parenOpen = pos - 1;
    parenClose = pos + param[0].length;
    pos = parenClose;
  }
  while (pos < bodyEnd && /\s/.test(text[pos])) pos += 1;
  if (text[pos] === ':') {
    while (pos < bodyEnd && text[pos] !== '=') pos += 1;
  }
  if (text.slice(pos, pos + 2) !== '=>') return null;
  pos += 2;
  while (pos < bodyEnd && /\s/.test(text[pos])) pos += 1;
  if (text[pos] === '{') {
    const close = matchBalanced(text, pos);
    if (close === -1) return null;
    return { name, nameIndex, parenOpen, parenClose, bodyStart: pos + 1, bodyEnd: close };
  }
  return { name, nameIndex, parenOpen, parenClose, bodyStart: pos, bodyEnd: statementEnd(text, pos, bodyEnd) };
}

function findClassMethod(classInfo, name) {
  return classInfo.members.find((member) => member.name === name && member.bodyStart >= 0) ?? null;
}

function parseParams(paramsText) {
  return splitArgs(paramsText).map((part) => {
    const eqIdx = part.text.indexOf('=');
    let head = part.text;
    let def;
    if (eqIdx !== -1) {
      head = part.text.slice(0, eqIdx);
      def = part.text.slice(eqIdx + 1).trim();
    }
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(head.trim());
    return { name: nameMatch ? nameMatch[0] : '', default: def };
  });
}

function extractReturnExpr(bodyText) {
  const idx = bodyText.search(/\breturn\b/);
  if (idx === -1) return null;
  let i = idx + 6;
  while (bodyText[i] === ' ' || bodyText[i] === '\t') i += 1;
  const start = i;
  let depth = 0;
  while (i < bodyText.length) {
    const ch = bodyText[i];
    if (ch === "'" || ch === '"') {
      i = skipString(bodyText, i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(bodyText, i);
      continue;
    }
    if ('([{'.includes(ch)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && depth === 0) return bodyText.slice(start, i);
    i += 1;
  }
  return bodyText.slice(start);
}

function findFieldLiteral(classInfo, fieldName, fileText) {
  const re = new RegExp(
    `(?:private|public|protected|readonly)\\s+${fieldName}\\s*(?::\\s*[\\w$]+)?\\s*=\\s*(['"\`])`,
  );
  const window = fileText.slice(classInfo.bodyStart, classInfo.bodyEnd);
  const m = re.exec(window);
  if (!m) return null;
  const quote = m[1];
  const quoteIdx = classInfo.bodyStart + m.index + m[0].length - 1;
  const end = quote === '`' ? skipTemplate(fileText, quoteIdx) : skipString(fileText, quoteIdx, quote);
  return fileText.slice(quoteIdx + 1, end - 1);
}

function inlineBuilder(builder, callArgParts, ctx, depth) {
  const paramsText = ctx.fileText.slice(builder.parenOpen + 1, builder.parenClose);
  const params = parseParams(paramsText);
  const bodyText = ctx.fileText.slice(builder.bodyStart, builder.bodyEnd);
  const returnExpr = extractReturnExpr(bodyText);
  if (returnExpr === null) return null;
  const lit = fullLiteral(returnExpr.trim());
  if (lit === null) return null;
  let result = lit;
  for (let idx = 0; idx < params.length; idx += 1) {
    const param = params[idx];
    if (!param.name) continue;
    const callArg = callArgParts[idx];
    let sub = '';
    if (callArg !== undefined && callArg.trim().length > 0) {
      const resolved = resolveArgument(callArg, ctx, depth + 1);
      sub = resolved.template;
    } else if (param.default !== undefined) {
      const defaultLit = fullLiteral(param.default.trim());
      sub = defaultLit !== null ? defaultLit : '';
    }
    result = result.split(`\${${param.name}}`).join(sub);
  }
  return result;
}

function resolveArgument(argText, ctx, depth = 0) {
  const trimmed = argText.trim();
  if (depth > 4) return { template: bestPartial(trimmed), resolved: false };
  if (trimmed.length === 0) return { template: '*', resolved: false };

  const lit = fullLiteral(trimmed);
  if (lit !== null) return { template: lit, resolved: true };

  const callMatch = /^this\.([A-Za-z_$][\w$]*)\((.*)\)$/s.exec(trimmed);
  if (callMatch) {
    const methodName = callMatch[1];
    const rawArgs = callMatch[2];
    const builder = findClassMethod(ctx.classInfo, methodName);
    if (builder) {
      const callArgParts = splitArgs(rawArgs).map((part) => part.text);
      const inlined = inlineBuilder(builder, callArgParts, ctx, depth);
      if (inlined !== null) return { template: inlined, resolved: true };
    }
    return { template: bestPartial(trimmed), resolved: false };
  }

  const fieldMatch = /^this\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (fieldMatch) {
    const value = findFieldLiteral(ctx.classInfo, fieldMatch[1], ctx.fileText);
    if (value !== null) return { template: value, resolved: true };
    return { template: `\${${trimmed}}`, resolved: false };
  }

  const plusParts = splitPlus(trimmed);
  if (plusParts.length > 1) {
    let template = '';
    let allResolved = true;
    for (const part of plusParts) {
      const resolved = resolveArgument(part, ctx, depth + 1);
      template += resolved.template;
      if (!resolved.resolved) allResolved = false;
    }
    return { template, resolved: allResolved };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const localConst = findLocalConst(ctx, trimmed);
    if (localConst !== null) return resolveArgument(localConst, ctx, depth + 1);
    return { template: `\${${trimmed}}`, resolved: false };
  }

  return { template: bestPartial(trimmed), resolved: false };
}

/** TypeScript file processing: component / injects / gateway_call. */

function extractQuotedProp(text, propName, windowStart, windowEnd) {
  const re = new RegExp(`\\b${propName}\\s*:\\s*(['"\`])`);
  const window = text.slice(windowStart, windowEnd);
  const m = re.exec(window);
  if (!m) return null;
  const quote = m[1];
  const quoteIdx = windowStart + m.index + m[0].length - 1;
  const end = quote === '`' ? skipTemplate(text, quoteIdx) : skipString(text, quoteIdx, quote);
  return { raw: text.slice(quoteIdx + 1, end - 1) };
}

function processTsFile(repoRoot, absPath, facts, classInfos) {
  const raw = readFileSync(absPath, 'utf8');
  const code = blankComments(raw);
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);
  const isPage = basename(absPath).endsWith('.page.ts');

  processActionDefs(code, relPath, lineOf, facts);

  const decoratorRe = /@(Component|Injectable)\s*\(/g;
  let m;
  while ((m = decoratorRe.exec(code))) {
    const decoratorName = m[1];
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;

    const searchWindowEnd = Math.min(code.length, parenClose + 4000);
    const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(code.slice(parenClose, searchWindowEnd));
    if (!classMatch) continue;
    const className = classMatch[1];
    const classKeywordEnd = parenClose + classMatch.index + classMatch[0].length;
    const bodyOpen = code.indexOf('{', classKeywordEnd);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalanced(code, bodyOpen);
    if (bodyClose === -1) continue;

    let selector = '';
    let role = 'component';
    let templateKind = 'none';
    let templateUrl;
    let inlineTemplate;

    if (decoratorName === 'Injectable') {
      role = 'service';
    } else {
      role = isPage ? 'page' : 'component';
      const selectorProp = extractQuotedProp(code, 'selector', parenOpen, parenClose);
      selector = selectorProp ? selectorProp.raw : '';
      const templateUrlProp = extractQuotedProp(code, 'templateUrl', parenOpen, parenClose);
      if (templateUrlProp) {
        templateKind = 'url';
        templateUrl = templateUrlProp.raw;
      } else {
        const templateProp = extractQuotedProp(code, 'template', parenOpen, parenClose);
        if (templateProp) {
          templateKind = 'inline';
          inlineTemplate = templateProp.raw;
        }
      }
    }

    facts.push(
      fact('component', {
        file: relPath,
        line: lineOf(m.index),
        name: className,
        selector,
        role,
      }),
    );

    const classInfo = {
      className,
      absPath,
      relPath,
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose,
      fields: [],
      members: [],
    };
    classInfo.members = splitClassMembers(code, classInfo.bodyStart, classInfo.bodyEnd);

    processConstructor(code, classInfo, relPath, lineOf, facts);
    processFieldInjections(code, classInfo, relPath, lineOf, facts);
    processGatewayCalls(code, classInfo, relPath, lineOf, facts);
    processEffects(code, classInfo, relPath, lineOf, facts);
    processMethodBodies(code, classInfo, relPath, lineOf, facts);

    if (templateKind === 'url') {
      classInfo.templateKind = 'url';
      classInfo.templateUrl = templateUrl;
    } else if (templateKind === 'inline') {
      classInfo.templateKind = 'inline';
      classInfo.inlineTemplate = inlineTemplate;
    } else {
      classInfo.templateKind = 'none';
    }
    classInfos.push(classInfo);
  }
}

function processConstructor(code, classInfo, relPath, lineOf, facts) {
  const ctor = classInfo.members.find((member) => member.name === 'constructor');
  if (!ctor) return;
  const paramsText = code.slice(ctor.parenOpen + 1, ctor.parenClose);
  const parts = splitArgs(paramsText);
  for (const part of parts) {
    const match = PARAM_RE.exec(part.text);
    if (!match) continue;
    const fieldName = match[1];
    const typeName = match[2];
    classInfo.fields.push({ name: fieldName, type: typeName });
    facts.push(
      fact('injects', {
        file: relPath,
        line: lineOf(ctor.parenOpen + 1 + part.start),
        from: classInfo.className,
        to: typeName,
      }),
    );
  }
}

function processFieldInjections(code, classInfo, relPath, lineOf, facts) {
  INJECT_FIELD_RE.lastIndex = 0;
  const window = code.slice(classInfo.bodyStart, classInfo.bodyEnd);
  let m;
  while ((m = INJECT_FIELD_RE.exec(window))) {
    const fieldName = m[1];
    const typeName = m[2];
    classInfo.fields.push({ name: fieldName, type: typeName });
    facts.push(
      fact('injects', {
        file: relPath,
        line: lineOf(classInfo.bodyStart + m.index),
        from: classInfo.className,
        to: typeName,
      }),
    );
  }
}

function processGatewayCalls(code, classInfo, relPath, lineOf, facts) {
  const gatewayFields = classInfo.fields
    .filter((field) => field.type === 'GatewayService')
    .map((field) => field.name);
  if (gatewayFields.length === 0) return;

  const verbGroup = GATEWAY_VERBS.join('|');
  const fieldGroup = gatewayFields.map(escapeRegExp).join('|');
  const callRe = new RegExp(`this\\.(?:${fieldGroup})\\.(${verbGroup})\\b`, 'g');

  for (const member of classInfo.members) {
    if (member.name === 'constructor') continue;
    callRe.lastIndex = member.bodyStart;
    let m;
    while ((m = callRe.exec(code)) && m.index < member.bodyEnd) {
      try {
        let pos = m.index + m[0].length;
        while (code[pos] === ' ' || code[pos] === '\n' || code[pos] === '\t' || code[pos] === '\r') pos += 1;
        if (code[pos] === '<') {
          let depth = 0;
          let j = pos;
          while (j < member.bodyEnd) {
            if (code[j] === '<') depth += 1;
            else if (code[j] === '>') {
              depth -= 1;
              if (depth === 0) {
                j += 1;
                break;
              }
            }
            j += 1;
          }
          pos = j;
          while (code[pos] === ' ' || code[pos] === '\n' || code[pos] === '\t' || code[pos] === '\r') pos += 1;
        }
        if (code[pos] !== '(') continue;
        const argsClose = matchBalanced(code, pos);
        if (argsClose === -1) continue;
        const argsText = code.slice(pos + 1, argsClose);
        const argParts = splitArgs(argsText);
        const firstArg = argParts.length > 0 ? argParts[0].text : '';
        const ctx = {
          classInfo,
          fileText: code,
          memberBodyStart: member.bodyStart,
          callIndex: m.index,
        };
        let resolved;
        try {
          resolved = resolveArgument(firstArg, ctx);
        } catch {
          resolved = { template: '*', resolved: false };
        }
        const flattened = flattenInterpolations(resolved.template);
        facts.push(
          fact('gateway_call', {
            file: relPath,
            line: lineOf(m.index),
            service: classInfo.className,
            method: member.name,
            verb: m[1].toUpperCase(),
            template: flattened.text,
            resolved: resolved.resolved && !flattened.collapsed,
          }),
        );
      } catch {
        facts.push(
          fact('gateway_call', {
            file: relPath,
            line: lineOf(m.index),
            service: classInfo.className,
            method: member.name,
            verb: m[1].toUpperCase(),
            template: '*',
            resolved: false,
          }),
        );
      }
    }
  }
}

/**
 * The action a `dispatch(...)` or `ofType(...)` argument names. Action creators travel
 * through barrel files and namespace imports, so only the function's own name is kept —
 * `loadCart`, `CartActions.loadCart` and `new LoadCart(...)` all resolve to one name, and
 * a string action type resolves to none.
 */
function actionNameOf(argText) {
  let text = String(argText || '').trim();
  if (/^new\s/.test(text)) text = text.replace(/^new\s+/, '');
  const path = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]*>\s*)?(?:\(|$)/.exec(text);
  if (!path) return null;
  const name = path[1].split('.').pop().trim();
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

/** Every exported `const <name> = createAction(` in the file, whatever else the file holds. */
function processActionDefs(code, relPath, lineOf, facts) {
  ACTION_DEF_RE.lastIndex = 0;
  let m;
  while ((m = ACTION_DEF_RE.exec(code))) {
    facts.push(fact('action_def', { file: relPath, line: lineOf(m.index), action: m[1] }));
  }
}

/**
 * One `effect_handler` per effect field, carrying every action its `ofType` filters name.
 * One effect may listen to several actions and several effects may listen to one, so both
 * sides stay lists and neither is deduplicated across effects.
 */
function processEffects(code, classInfo, relPath, lineOf, facts) {
  for (const member of classInfo.members) {
    if (member.effect !== true) continue;
    const actions = [];
    OF_TYPE_RE.lastIndex = member.bodyStart;
    let m;
    while ((m = OF_TYPE_RE.exec(code)) && m.index < member.bodyEnd) {
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = matchBalanced(code, parenOpen);
      if (parenClose === -1) continue;
      for (const part of splitArgs(code.slice(parenOpen + 1, parenClose))) {
        const name = actionNameOf(part.text);
        if (name && !actions.includes(name)) actions.push(name);
      }
      OF_TYPE_RE.lastIndex = parenClose;
    }
    if (actions.length === 0) continue;
    facts.push(
      fact('effect_handler', {
        file: relPath,
        line: lineOf(member.nameIndex),
        endLine: lineOf(member.bodyEnd),
        class: classInfo.className,
        field: member.name,
        actions,
      }),
    );
  }
}

/** One `action_dispatch` per `dispatch(...)` whose first argument names an action. */
function processDispatches(code, member, classInfo, relPath, lineOf, facts) {
  DISPATCH_RE.lastIndex = member.bodyStart;
  let m;
  while ((m = DISPATCH_RE.exec(code)) && m.index < member.bodyEnd) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    DISPATCH_RE.lastIndex = parenClose;
    const parts = splitArgs(code.slice(parenOpen + 1, parenClose));
    const action = parts.length > 0 ? actionNameOf(parts[0].text) : null;
    if (!action) continue;
    facts.push(
      fact('action_dispatch', {
        file: relPath,
        line: lineOf(m.index),
        class: classInfo.className,
        method: member.name,
        action,
      }),
    );
  }
}

/**
 * One `method_span` per class member with a body, and one `method_call` per call that
 * leads somewhere the walk can follow: a sibling member of the same class, recorded with
 * receiver `this`, or an injected field, recorded under the class name `injects` gave it.
 * A `GatewayService` field is left out — its calls are already `gateway_call` facts, as
 * is the NgRx action stream, and so is every `dispatch`, which `action_dispatch` records
 * with the action it carries.
 */
function processMethodBodies(code, classInfo, relPath, lineOf, facts) {
  const memberNames = new Set(classInfo.members.map((member) => member.name));
  const injected = new Map();
  for (const field of classInfo.fields) {
    if (field.type === GATEWAY_TYPE || field.type === EFFECT_SOURCE_TYPE) continue;
    if (!injected.has(field.name)) injected.set(field.name, field.type);
  }

  for (const member of classInfo.members) {
    facts.push(
      fact('method_span', {
        file: relPath,
        line: lineOf(member.nameIndex),
        endLine: lineOf(member.bodyEnd),
        class: classInfo.className,
        method: member.name,
      }),
    );

    processDispatches(code, member, classInfo, relPath, lineOf, facts);

    BODY_CALL_RE.lastIndex = member.bodyStart;
    let m;
    while ((m = BODY_CALL_RE.exec(code)) && m.index < member.bodyEnd) {
      const receiver = m[1];
      const called = m[2];
      if (called === 'dispatch') continue;
      const resolved = called
        ? injected.has(receiver)
          ? { field: injected.get(receiver), calledMethod: called }
          : null
        : memberNames.has(receiver)
          ? { field: 'this', calledMethod: receiver }
          : null;
      if (!resolved) continue;
      facts.push(
        fact('method_call', {
          file: relPath,
          line: lineOf(m.index),
          class: classInfo.className,
          method: member.name,
          ...resolved,
        }),
      );
    }
  }
}

/** renders: template scanning against the known selector set. */

function findCustomTags(html) {
  const tags = [];
  const re = /<([A-Za-z][\w-]*)\b/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].includes('-')) tags.push({ tag: m[1], index: m.index });
  }
  return tags;
}

function processRenders(repoRoot, classInfo, selectorMap, facts) {
  let templateText;
  let templateRelPath;
  let lineOf;

  if (classInfo.templateKind === 'url') {
    const htmlAbsPath = resolvePath(dirname(classInfo.absPath), classInfo.templateUrl);
    if (!existsSync(htmlAbsPath)) return;
    templateText = readFileSync(htmlAbsPath, 'utf8');
    templateRelPath = toRelative(repoRoot, htmlAbsPath);
    lineOf = makeLineFinder(templateText);
  } else if (classInfo.templateKind === 'inline') {
    templateText = classInfo.inlineTemplate;
    templateRelPath = classInfo.relPath;
    lineOf = makeLineFinder(templateText);
  } else {
    return;
  }

  const tags = findCustomTags(templateText);
  for (const { tag, index } of tags) {
    if (!selectorMap.has(tag)) continue;
    facts.push(
      fact('renders', {
        file: templateRelPath,
        line: lineOf(index),
        from: classInfo.className,
        to: tag,
      }),
    );
  }

  for (const binding of findEventBindings(templateText)) {
    facts.push(
      fact('template_handler', {
        file: templateRelPath,
        line: lineOf(binding.index),
        component: classInfo.className,
        event: binding.event,
        handler: binding.handler,
        args: binding.args,
        kind: binding.kind,
      }),
    );
  }
}

/**
 * Calls named by one binding expression. A bare name or `this.name` is the component's
 * own handler; anything reached through another receiver belongs to that receiver and is
 * not a handler of this component.
 */
function bindingCalls(expression) {
  const calls = [];
  HANDLER_CALL_RE.lastIndex = 0;
  let m;
  while ((m = HANDLER_CALL_RE.exec(expression))) {
    const name = m[1];
    if (TEMPLATE_NON_HANDLERS.has(name)) continue;
    const before = expression.slice(0, m.index).trimEnd();
    if (!m[0].startsWith('this') && before.endsWith('.')) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(expression, parenOpen);
    if (parenClose === -1) continue;
    calls.push({ handler: name, args: expression.slice(parenOpen + 1, parenClose).trim() });
    HANDLER_CALL_RE.lastIndex = parenClose;
  }
  return calls;
}

/**
 * Every `(event)="…"` binding in a template, whatever block it sits in — control-flow
 * blocks and structural directives are ordinary text to a scan of the whole template.
 * A binding that only assigns is kept as its own kind, because it names no method to
 * walk into but is still a user action the template offers.
 */
function findEventBindings(templateText) {
  const bindings = [];
  EVENT_BINDING_RE.lastIndex = 0;
  let m;
  while ((m = EVENT_BINDING_RE.exec(templateText))) {
    const event = m[1];
    const expression = m[3];
    const calls = bindingCalls(expression);
    if (calls.length > 0) {
      for (const call of calls) {
        bindings.push({ index: m.index, event, handler: call.handler, args: call.args, kind: 'call' });
      }
      continue;
    }
    const assigned = HANDLER_ASSIGN_RE.exec(expression);
    if (assigned) bindings.push({ index: m.index, event, handler: assigned[1], args: '', kind: 'assign' });
  }
  return bindings;
}

/** Cypress: cy.intercept() facts. */

function parseIntercept(parts) {
  const first = parts[0] ? parts[0].text.trim() : '';
  const firstLit = fullLiteral(first);

  if (firstLit !== null && HTTP_VERBS.has(firstLit.toUpperCase()) && parts.length > 1) {
    const second = parts[1].text.trim();
    const secondLit = fullLiteral(second);
    return { verb: firstLit.toUpperCase(), pattern: secondLit !== null ? secondLit : second };
  }
  if (firstLit !== null) {
    return { verb: 'ANY', pattern: firstLit };
  }
  const regexLit = /^\/(.+)\/[a-z]*$/.exec(first);
  if (regexLit) {
    return { verb: 'ANY', pattern: regexLit[1] };
  }
  if (first.startsWith('{')) {
    const methodMatch = /method\s*:\s*(['"`])(\w+)\1/.exec(first);
    const urlMatch = /url\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(first);
    if (methodMatch || urlMatch) {
      return {
        verb: methodMatch ? methodMatch[2].toUpperCase() : 'ANY',
        pattern: urlMatch ? urlMatch[2] : first,
      };
    }
  }
  return { verb: 'ANY', pattern: first || '*' };
}

const DESCRIBE_SKIP_RE = /\b(?:describe|context)\.skip\s*\(|\bxdescribe\s*\(/g;
const IT_RE = /\b(it|xit)(\.(only|skip))?\s*\(/g;

function findDescribeSkipSpans(code) {
  const spans = [];
  DESCRIBE_SKIP_RE.lastIndex = 0;
  let m;
  while ((m = DESCRIBE_SKIP_RE.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    spans.push({ start: parenOpen, end: parenClose });
  }
  return spans;
}

function findItBlocks(code) {
  const blocks = [];
  IT_RE.lastIndex = 0;
  let m;
  while ((m = IT_RE.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const argsText = code.slice(parenOpen + 1, parenClose);
    const parts = splitArgs(argsText);
    const titleLit = parts.length > 0 ? fullLiteral(parts[0].text) : null;
    if (titleLit === null) continue;
    const ownSkip = m[1] === 'xit' || m[3] === 'skip';
    blocks.push({ title: titleLit, index: m.index, start: parenOpen, end: parenClose, ownSkip });
  }
  return blocks;
}

function isInsideSkipDescribe(position, describeSkipSpans) {
  return describeSkipSpans.some((span) => position > span.start && position < span.end);
}

function findNearestItBlock(position, itBlocks) {
  let nearest = null;
  let bestSpan = Infinity;
  for (const block of itBlocks) {
    if (position > block.start && position < block.end) {
      const span = block.end - block.start;
      if (span < bestSpan) {
        bestSpan = span;
        nearest = block;
      }
    }
  }
  return nearest;
}

function processCypressFile(repoRoot, absPath, facts, isE2e) {
  const raw = readFileSync(absPath, 'utf8');
  const code = blankComments(raw);
  const relPath = toRelative(repoRoot, absPath);
  const lineOf = makeLineFinder(code);

  const describeSkipSpans = findDescribeSkipSpans(code);
  const itBlocks = findItBlocks(code);

  if (isE2e) {
    for (const block of itBlocks) {
      const skipped = block.ownSkip || isInsideSkipDescribe(block.start, describeSkipSpans);
      facts.push(
        fact('cypress_test', {
          file: relPath,
          line: lineOf(block.index),
          spec: relPath,
          test: block.title,
          skipped,
        }),
      );
    }
  }

  const interceptRe = /\bcy\.intercept\s*\(/g;
  let m;
  while ((m = interceptRe.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBalanced(code, parenOpen);
    if (parenClose === -1) continue;
    const argsText = code.slice(parenOpen + 1, parenClose);
    const parts = splitArgs(argsText);
    const parsed = parseIntercept(parts);

    const nearest = findNearestItBlock(m.index, itBlocks);
    const test = nearest ? nearest.title : '';
    const skipped = isInsideSkipDescribe(m.index, describeSkipSpans) || (nearest ? nearest.ownSkip : false);

    facts.push(
      fact('cypress_intercept', {
        file: relPath,
        line: lineOf(m.index),
        spec: relPath,
        test,
        verb: parsed.verb,
        pattern: parsed.pattern,
        skipped,
      }),
    );
  }
}

/**
 * The web side of the control evidence: the frames that hold a call inside one TS/JS body,
 * whether an `await` heads it, and whether it starts a promise that a join names.
 *
 * The forms here are the ones the Design's web scope names: `if`, `else`, `switch` and
 * `catch` arms, loops, `await`, `Promise.all` and `Promise.allSettled` launches and joins,
 * the `.then` and `.catch` continuations, and the async forms the source cannot order.
 *
 * A function returned by a member is that member's body, not a callback: only a function
 * written inside a call's arguments is framed as one.
 */
import { frameId } from '../control-evidence.js';

const MAX_TEXT = 120;
const ASYNC_FORMS = new Set(['Promise.race', 'Promise.any']);
const LAUNCH_FORMS = new Set(['Promise.all', 'Promise.allSettled']);

function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch || '');
}

function skipSpace(masked, from, limit) {
  let i = from;
  while (i < limit && /\s/.test(masked[i])) i += 1;
  return i;
}

function findMatching(masked, openIndex, open, close, limit = masked.length) {
  let depth = 0;
  for (let i = openIndex; i < limit; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function statementEnd(masked, start, limit) {
  const first = skipSpace(masked, start, limit);
  if (masked[first] === '{') {
    const close = findMatching(masked, first, '{', '}', limit);
    return close === null ? limit : close + 1;
  }
  let depth = 0;
  for (let i = first; i < limit; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === ';' && depth === 0) return i + 1;
  }
  return limit;
}

function readWord(masked, index, limit) {
  let i = index;
  while (i < limit && isIdentPart(masked[i])) i += 1;
  return masked.slice(index, i);
}

function chainStart(masked, paren, limit) {
  let start = paren;
  let i = paren - 1;
  while (i >= limit) {
    const ch = masked[i];
    if (ch === ' ') {
      i -= 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch) || ch === '.' || ch === '?') {
      start = i;
      i -= 1;
      continue;
    }
    break;
  }
  return start;
}

/** The left edge of a lambda's parameter list: its `(`, or a bare identifier. */
function parameterListStart(masked, beforeArrow, limit) {
  let index = beforeArrow;
  while (index >= limit && /\s/.test(masked[index])) index -= 1;
  if (masked[index] === ')') {
    let depth = 0;
    for (; index >= limit; index -= 1) {
      if (masked[index] === ')') depth += 1;
      else if (masked[index] === '(') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return index + 1;
  }
  while (index >= limit && /[A-Za-z0-9_$]/.test(masked[index])) index -= 1;
  return index + 1;
}

function collapsedText(code, from, to) {
  return code
    .slice(from, to)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** The innermost of `spans` that holds `index`, so a nested member body wins over its class. */
function innermostSpan(spans, index) {
  let best = null;
  for (const span of spans) {
    if (span.start <= index && index < span.end) {
      if (!best || span.end - span.start < best.end - best.start) best = span;
    }
  }
  return best;
}

function scanBody(code, masked, lineOf, span) {
  const begin = span.start;
  const end = span.end;
  const frames = [];
  const awaits = [];
  const tasks = [];

  const columnAt = (index) => index - (code.lastIndexOf('\n', index - 1) + 1) + 1;
  const pushFrame = (frame, from, to) => {
    if (to > from) frames.push({ from, to, frame });
  };
  const headFrame = (kind, form, index, fields) => ({
    kind,
    form,
    id: frameId(form, lineOf(index), columnAt(index)),
    line: lineOf(index),
    column: columnAt(index),
    text: collapsedText(code, index, Math.min(end, index + MAX_TEXT)),
    ...fields,
  });

  const expressionEnd = (from, limit) => {
    let depth = 0;
    for (let i = from; i < limit; i += 1) {
      const ch = masked[i];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) return i;
        depth -= 1;
        continue;
      }
      if (depth !== 0) continue;
      if (ch === ';' || ch === ',') return i;
      if (ch === '&' && masked[i + 1] === '&') return i;
      if (ch === '|' && masked[i + 1] === '|') return i;
      if (ch === '?' && masked[i + 1] === '?') return i;
    }
    return limit;
  };

  const callsIn = (from, to) => {
    const calls = [];
    const callRe = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
    let match;
    const text = masked.slice(from, to);
    while ((match = callRe.exec(text))) {
      const paren = from + match.index + match[0].length - 1;
      const chain = chainStart(masked, paren, from);
      calls.push({ chain, paren, name: match[1].split('.').pop() });
    }
    return calls;
  };

  const enclosingCallName = (index) => {
    let depth = 0;
    for (let i = index - 1; i >= begin; i -= 1) {
      const ch = masked[i];
      if (ch === ')' || ch === ']') depth += 1;
      else if (ch === '(' || ch === '[') {
        if (depth === 0) {
          if (ch === '(' && isIdentPart(masked[i - 1])) {
            const start = chainStart(masked, i, begin);
            const chain = masked.slice(start, i).replace(/\s+/g, '');
            const parts = chain.split('.');
            return parts[parts.length - 1] || null;
          }
          return null;
        }
        depth -= 1;
      } else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) {
        return null;
      }
    }
    return null;
  };

  const enclosingAsync = (index) => {
    for (let i = index - 1; i >= Math.max(begin, index - 40); i -= 1) {
      if (masked.startsWith('async', i) && !isIdentPart(masked[i - 1]) && !isIdentPart(masked[i + 5])) return true;
      if (masked[i] === ';' || masked[i] === '{') return false;
    }
    return false;
  };

  const scanFunctionValue = (arrowIndex, paramsStart, bodyStart, bodyEnd, form, kind) => {
    const frame = {
      kind,
      form,
      id: frameId(form, lineOf(arrowIndex), columnAt(arrowIndex)),
      line: lineOf(arrowIndex),
      column: columnAt(arrowIndex),
      text: collapsedText(code, paramsStart, bodyStart),
      ...(kind === 'callback' ? { host: enclosingCallName(paramsStart) } : {}),
    };
    pushFrame(frame, bodyStart, bodyEnd);
    if (masked[bodyStart] === '{') {
      const close = findMatching(masked, bodyStart, '{', '}', bodyEnd);
      if (close !== null) scanRegion(bodyStart + 1, close);
    } else {
      operatorScan(bodyStart, bodyEnd, [[bodyStart, bodyEnd]]);
    }
  };

  const functionsIn = (from, to) => {
    const found = [];
    const arrowRe = /(?:async\s+)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
    const text = masked.slice(from, to);
    let match;
    while ((match = arrowRe.exec(text))) {
      const arrow = from + match.index + match[0].length - 2;
      const paramsStart = parameterListStart(masked, arrow - 1, from);
      const bodyStart = skipSpace(masked, arrow + 2, to);
      let bodyEnd;
      if (masked[bodyStart] === '{') {
        const close = findMatching(masked, bodyStart, '{', '}', to);
        if (close === null) continue;
        bodyEnd = close + 1;
      } else {
        bodyEnd = expressionEnd(bodyStart, to);
      }
      found.push({ arrow, paramsStart, bodyStart, bodyEnd });
      arrowRe.lastIndex = match.index + match[0].length;
    }
    const functionRe = /\bfunction\b\s*[A-Za-z_$]*\s*\([^()]*\)\s*\{/g;
    while ((match = functionRe.exec(text))) {
      const open = from + match.index + match[0].length - 1;
      const close = findMatching(masked, open, '{', '}', to);
      if (close === null) continue;
      found.push({ arrow: from + match.index, paramsStart: from + match.index, bodyStart: open, bodyEnd: close + 1 });
      functionRe.lastIndex = match.index + match[0].length;
    }
    return found.sort((a, b) => a.arrow - b.arrow);
  };

  function scanOrdinary(start, limit) {
    const stop = statementEnd(masked, start, limit);
    const opaque = [];
    for (const fn of functionsIn(start, stop)) {
      if (!insideArguments(masked, fn.arrow, begin)) continue;
      // A `.then` or `.catch` handler is framed as the continuation it answers, not as an
      // anonymous callback on top of it.
      const host = enclosingCallName(fn.arrow);
      if (host === 'then' || host === 'catch') continue;
      if (withinPromiseLaunch(masked, fn.arrow, begin)) {
        scanFunctionValue(fn.arrow, fn.paramsStart, fn.bodyStart, fn.bodyEnd, 'map', 'loop');
      } else {
        scanFunctionValue(
          fn.arrow,
          fn.paramsStart,
          fn.bodyStart,
          fn.bodyEnd,
          enclosingAsync(fn.arrow) ? 'async-effect-callback' : 'callback',
          'callback',
        );
      }
      opaque.push([fn.arrow, fn.bodyEnd]);
    }
    operatorScan(start, stop, opaque);
    return stop;
  }

  function operatorScan(from, to, opaque) {
    for (let i = from; i < to; i += 1) {
      const skipTo = opaque.find((range) => i >= range[0] && i < range[1]);
      if (skipTo) {
        i = skipTo[1] - 1;
        continue;
      }
      const ch = masked[i];
      if (ch === 'a' && masked.startsWith('await', i) && !isIdentPart(masked[i - 1]) && !isIdentPart(masked[i + 5])) {
        const operand = skipSpace(masked, i + 5, to);
        let paren = -1;
        for (let k = operand; k < to; k += 1) {
          if (masked[k] === ';') break;
          if (masked[k] === '(' && isIdentPart(masked[k - 1])) {
            paren = k;
            break;
          }
        }
        if (paren !== -1) awaits.push({ from: i, to: paren + 1 });
        i += 4;
        continue;
      }
      if (ch === '.' && masked.startsWith('.then', i) && !isIdentPart(masked[i + 5])) {
        scanContinuation(i, 'then', 'success', to);
        continue;
      }
      if (ch === '.' && masked.startsWith('.catch', i) && !isIdentPart(masked[i + 6])) {
        scanContinuation(i, 'catch', 'failure', to);
        continue;
      }
      if (ch === 'P' && masked.startsWith('Promise', i) && !isIdentPart(masked[i - 1])) {
        const dot = skipSpace(masked, i + 7, to);
        if (masked[dot] === '.') {
          const name = readWord(masked, skipSpace(masked, dot + 1, to), to);
          const form = `Promise.${name}`;
          if (LAUNCH_FORMS.has(form) || ASYNC_FORMS.has(form)) {
            const openParen = skipSpace(masked, skipSpace(masked, dot + 1, to) + name.length, to);
            if (masked[openParen] === '(') {
              const closeParen = findMatching(masked, openParen, '(', ')', to);
              if (closeParen !== null) {
                if (LAUNCH_FORMS.has(form)) registerLaunch(i, form, openParen, closeParen);
                else pushFrame(headFrame('async-form', form, i, { text: form }), openParen + 1, closeParen);
                i = openParen;
                continue;
              }
            }
          }
        }
      }
      if (ch === '?' && masked[i + 1] === '.' && masked[i + 2] !== '.') {
        pushFrame(headFrame('arm', '?.', i, { arm: 'non-null', text: '?.' }), i + 2, expressionEnd(i + 2, to));
        continue;
      }
      if (ch === '?' && masked[i + 1] === '?') {
        pushFrame(headFrame('arm', '??', i, { arm: 'right', text: '??' }), i + 2, expressionEnd(i + 2, to));
        continue;
      }
      if (ch === '?' && masked[i + 1] !== '?') {
        const colon = matchingColon(i, to);
        if (colon === -1) continue;
        const frame = headFrame('arm', '?:', i, { arm: 'true', text: '?:' });
        pushFrame(frame, i + 1, colon);
        pushFrame({ ...frame, arm: 'false' }, colon + 1, expressionEnd(i + 1, to));
        continue;
      }
      if (ch === '&' && masked[i + 1] === '&') {
        pushFrame(headFrame('arm', '&&', i, { arm: 'right', text: '&&' }), i + 2, expressionEnd(i + 2, to));
        continue;
      }
      if (ch === '|' && masked[i + 1] === '|') {
        pushFrame(headFrame('arm', '||', i, { arm: 'right', text: '||' }), i + 2, expressionEnd(i + 2, to));
      }
    }
  }

  /** The request a `.then` or `.catch` answers: the last gateway call written before it. */
  const gatewaySiteBefore = (dotIndex) => {
    for (let i = dotIndex - 1; i >= begin; i -= 1) {
      if (masked.startsWith('getGatewayClient', i) && !isIdentPart(masked[i - 1])) {
        const open = skipSpace(masked, i + 'getGatewayClient'.length, dotIndex);
        if (masked[open] === '(') {
          // The walk states a gateway call at its `httpClient` receiver, so the answer is
          // the same token the fact names, not the start of the whole expression.
          const receiver = masked.lastIndexOf('httpClient', i);
          const at = receiver >= begin ? receiver : i;
          return { line: lineOf(at), column: columnAt(at) };
        }
      }
    }
    return { line: lineOf(dotIndex), column: columnAt(dotIndex) };
  };

  const matchingColon = (question, limit) => {
    let nested = 0;
    for (let i = question + 1; i < limit; i += 1) {
      const ch = masked[i];
      if (ch === '?' && masked[i + 1] !== '?' && masked[i + 1] !== '.') nested += 1;
      else if (ch === ':') {
        if (masked[i + 1] === ':') continue;
        if (nested === 0) return i;
        nested -= 1;
      } else if (ch === ';' || ch === ')') return -1;
    }
    return -1;
  };

  function scanContinuation(dotIndex, form, outcome, limit) {
    const nameEnd = dotIndex + 1 + form.length;
    const openParen = skipSpace(masked, nameEnd, limit);
    if (masked[openParen] !== '(') return;
    const closeParen = findMatching(masked, openParen, '(', ')', limit);
    if (closeParen === null) return;
    const fn = functionsIn(openParen + 1, closeParen)[0];
    if (!fn) return;
    const answers = gatewaySiteBefore(dotIndex);
    const frame = {
      kind: 'continuation',
      form,
      id: frameId(form, lineOf(dotIndex), columnAt(dotIndex)),
      line: lineOf(dotIndex),
      column: columnAt(dotIndex),
      text: `.${form}`,
      outcome,
      of: answers,
    };
    pushFrame(frame, fn.bodyStart, fn.bodyEnd);
    if (masked[fn.bodyStart] === '{') {
      const close = findMatching(masked, fn.bodyStart, '{', '}', fn.bodyEnd);
      if (close !== null) scanRegion(fn.bodyStart + 1, close);
    } else {
      operatorScan(fn.bodyStart, fn.bodyEnd, [[fn.bodyStart, fn.bodyEnd]]);
    }
    void closeParen;
  }

  /** A `Promise.all`/`Promise.allSettled`: every call in its argument is a launched task. */
  function registerLaunch(keyword, form, openParen, closeParen) {
    const call = headFrame('async-form', form, keyword, { text: form });
    const join = {
      id: `${lineOf(keyword)}:${columnAt(keyword)}`,
      form,
      line: lineOf(keyword),
      column: columnAt(keyword),
      tasks: [],
    };
    const launched = callsIn(openParen + 1, closeParen);
    for (const entry of launched) {
      const id = `${lineOf(entry.chain)}:${columnAt(entry.chain)}`;
      if (!join.tasks.includes(id)) join.tasks.push(id);
      tasks.push({ range: [entry.chain, entry.paren + 1], task: { id, local: null, join } });
    }
    void call;
  }

  function scanIf(start, limit) {
    let openParen = -1;
    for (let i = start + 2; i < limit; i += 1) {
      if (masked[i] === '(') {
        openParen = i;
        break;
      }
    }
    if (openParen === -1) return statementEnd(masked, start, limit);
    const closeParen = findMatching(masked, openParen, '(', ')', limit);
    if (closeParen === null) return statementEnd(masked, start, limit);
    const text = collapsedText(code, start, closeParen + 1);
    const frame = headFrame('arm', 'if', start, { arm: 'then', text });
    const thenStart = skipSpace(masked, closeParen + 1, limit);
    const thenEnd = statementEnd(masked, thenStart, limit);
    pushFrame(frame, thenStart, thenEnd);
    scanStatement(thenStart, thenEnd);
    let next = skipSpace(masked, thenEnd, limit);
    if (masked.startsWith('else', next) && !isIdentPart(masked[next + 4])) {
      const elseStart = skipSpace(masked, next + 4, limit);
      const elseEnd = statementEnd(masked, elseStart, limit);
      // The else is the other arm of the same construct, so it carries that construct's
      // identity and only its `arm` says which side the call is on.
      pushFrame({ ...frame, arm: 'else' }, elseStart, elseEnd);
      scanStatement(elseStart, elseEnd);
      next = elseEnd;
    }
    return next;
  }

  function scanLoop(word, start, limit) {
    let openParen = -1;
    for (let i = start + word.length; i < limit; i += 1) {
      if (masked[i] === '(') {
        openParen = i;
        break;
      }
    }
    if (openParen === -1) return statementEnd(masked, start, limit);
    const closeParen = findMatching(masked, openParen, '(', ')', limit);
    if (closeParen === null) return statementEnd(masked, start, limit);
    const form = word === 'for' ? forForm(openParen + 1, closeParen) : word;
    const text = collapsedText(code, start, closeParen + 1);
    const bodyStart = skipSpace(masked, closeParen + 1, limit);
    const bodyEnd = statementEnd(masked, bodyStart, limit);
    const frame = headFrame('loop', form, start, { text });
    pushFrame(frame, form === 'for-of' || form === 'for-in' ? bodyStart : start, bodyEnd);
    scanStatement(bodyStart, bodyEnd);
    return bodyEnd;
  }

  const forForm = (from, to) => {
    const text = masked.slice(from, to);
    if (/\bof\b/.test(text)) return 'for-of';
    if (/\bin\b/.test(text)) return 'for-in';
    return 'for';
  };

  function scanDo(start, limit) {
    const bodyStart = skipSpace(masked, start + 2, limit);
    const bodyEnd = statementEnd(masked, bodyStart, limit);
    const frame = headFrame('loop', 'do', start, { text: 'do' });
    pushFrame(frame, start, bodyEnd);
    scanStatement(bodyStart, bodyEnd);
    return bodyEnd;
  }

  function scanSwitch(start, limit) {
    let openParen = -1;
    for (let i = start + 6; i < limit; i += 1) {
      if (masked[i] === '(') {
        openParen = i;
        break;
      }
    }
    if (openParen === -1) return statementEnd(masked, start, limit);
    const closeParen = findMatching(masked, openParen, '(', ')', limit);
    if (closeParen === null) return statementEnd(masked, start, limit);
    const open = skipSpace(masked, closeParen + 1, limit);
    if (masked[open] !== '{') return statementEnd(masked, start, limit);
    const close = findMatching(masked, open, '{', '}', limit);
    if (close === null) return limit;
    const text = collapsedText(code, start, closeParen + 1);
    const closeArm = (from, to, arm) => pushFrame({ ...headFrame('arm', 'switch', start, { arm, text }) }, from, to);
    let armStart = null;
    let arm = null;
    let depth = 0;
    for (let i = open + 1; i < close; i += 1) {
      const ch = masked[i];
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
      if (depth !== 0) continue;
      if (masked.startsWith('case', i) && !isIdentPart(masked[i - 1]) && !isIdentPart(masked[i + 4])) {
        const colon = caseColon(i + 4, close);
        if (colon === -1) continue;
        if (armStart !== null) closeArm(armStart, i, arm);
        arm = collapsedText(code, i, colon).replace(/\s+/g, ' ');
        armStart = colon + 1;
        i = colon;
        continue;
      }
      if (masked.startsWith('default', i) && !isIdentPart(masked[i - 1]) && !isIdentPart(masked[i + 7])) {
        const colon = caseColon(i + 7, close);
        if (colon === -1) continue;
        if (armStart !== null) closeArm(armStart, i, arm);
        arm = 'default';
        armStart = colon + 1;
        i = colon;
      }
    }
    if (armStart !== null) closeArm(armStart, close, arm);
    scanRegion(open + 1, close);
    return close + 1;
  }

  const caseColon = (from, limit) => {
    let depth = 0;
    for (let i = from; i < limit; i += 1) {
      const ch = masked[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === ':' && depth === 0 && masked[i + 1] !== ':') return i;
      else if (ch === ';' && depth === 0) return -1;
    }
    return -1;
  };

  function scanTry(start, limit) {
    const bodyStart = skipSpace(masked, start + 3, limit);
    const bodyEnd = statementEnd(masked, bodyStart, limit);
    // The parts of one try share its identity; `part` says which one a call is in.
    const base = headFrame('try', 'try', start, { part: 'body', text: 'try' });
    if (masked[bodyStart] === '{') {
      pushFrame(base, bodyStart + 1, bodyEnd - 1);
      scanRegion(bodyStart + 1, bodyEnd - 1);
    }
    let next = skipSpace(masked, bodyEnd, limit);
    let catchNumber = 0;
    while (masked.startsWith('catch', next) && !isIdentPart(masked[next + 5])) {
      catchNumber += 1;
      let clauseEnd = next + 5;
      const openParen = skipSpace(masked, clauseEnd, limit);
      if (masked[openParen] === '(') {
        const closeParen = findMatching(masked, openParen, '(', ')', limit);
        if (closeParen === null) break;
        clauseEnd = closeParen + 1;
      }
      const catchBody = skipSpace(masked, clauseEnd, limit);
      const after = statementEnd(masked, catchBody, limit);
      if (masked[catchBody] === '{') {
        pushFrame({ ...base, part: `catch ${catchNumber}` }, catchBody + 1, after - 1);
        scanRegion(catchBody + 1, after - 1);
      }
      next = skipSpace(masked, after, limit);
    }
    if (masked.startsWith('finally', next) && !isIdentPart(masked[next + 7])) {
      const finallyBody = skipSpace(masked, next + 7, limit);
      const after = statementEnd(masked, finallyBody, limit);
      if (masked[finallyBody] === '{') {
        pushFrame({ ...base, part: 'finally' }, finallyBody + 1, after - 1);
        scanRegion(finallyBody + 1, after - 1);
      }
      next = after;
    }
    return next;
  }

  function scanStatement(start, limit) {
    const i = skipSpace(masked, start, limit);
    if (i >= limit) return limit;
    const ch = masked[i];
    if (ch === '{') {
      const close = findMatching(masked, i, '{', '}', limit);
      if (close === null) return limit;
      scanRegion(i + 1, close);
      return close + 1;
    }
    if (ch === '}' || ch === ';') return i + 1;
    const word = readWord(masked, i, limit);
    if (word === 'if') return scanIf(i, limit);
    if (word === 'for' || word === 'while') return scanLoop(word, i, limit);
    if (word === 'do') return scanDo(i, limit);
    if (word === 'switch') return scanSwitch(i, limit);
    if (word === 'try') return scanTry(i, limit);
    if (word === 'else' || word === 'catch' || word === 'finally') return scanStatement(i + word.length, limit);
    return scanOrdinary(i, limit);
  }

  function scanRegion(from, to) {
    let i = skipSpace(masked, from, to);
    while (i < to) {
      i = scanStatement(i, to);
      i = skipSpace(masked, i, to);
    }
  }

  scanRegion(begin, end);

  const at = (offset) => {
    const seen = new Set();
    const path = frames
      .filter((entry) => entry.from <= offset && offset < entry.to)
      .sort((a, b) => a.from - b.from || b.to - a.to)
      .map((entry) => entry.frame)
      .filter((frame) => {
        if (seen.has(frame.id)) return false;
        seen.add(frame.id);
        return true;
      });
    const control = { path };
    if (awaits.some((range) => range.from <= offset && offset < range.to)) control.await = true;
    const task = tasks.find((entry) => entry.range[0] <= offset && offset < entry.range[1]);
    if (task) control.task = task.task;
    return control;
  };

  return { at };
}

/** Whether `index` sits inside the argument list of some call. */
function insideArguments(masked, index, limit) {  let depth = 0;
  for (let i = index - 1; i >= limit; i -= 1) {
    const ch = masked[i];
    if (ch === ')' || ch === ']') depth += 1;
    else if (ch === '(') {
      if (depth === 0) return Boolean(masked[i - 1] && isIdentPart(masked[i - 1]));
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) {
      return false;
    }
  }
  return false;
}

/** Whether `index` sits inside the argument list of a `Promise.all` or `Promise.allSettled`. */
function withinPromiseLaunch(masked, index, limit) {
  let cursor = index;
  while (cursor > limit) {
    let depth = 0;
    let open = -1;
    for (let i = cursor - 1; i >= limit; i -= 1) {
      const ch = masked[i];
      if (ch === ')' || ch === ']') depth += 1;
      else if (ch === '(') {
        if (depth > 0) depth -= 1;
        else {
          open = i;
          break;
        }
      }
    }
    if (open === -1) return false;
    let start = open - 1;
    while (start >= limit && (isIdentPart(masked[start]) || masked[start] === '.' || masked[start] === ' ')) start -= 1;
    const chain = masked.slice(start + 1, open).replace(/\s+/g, '');
    if (chain === 'Promise.all' || chain === 'Promise.allSettled') return true;
    // A `.map(...)` callback inside a launch is the launch's own body, so the search
    // continues outward from the `map` call.
    if (chain === 'map' || chain.endsWith('.map')) cursor = open;
    else return false;
  }
  return false;
}

/** Build the per-file reader the web emitters query with their own call offset. */
export function buildWebControl(code, masked, lineOf, spans) {
  const ordered = spans.filter((span) => span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start);
  const cache = new Map();
  return (offset) => {
    const column = offset - (code.lastIndexOf('\n', offset - 1) + 1) + 1;
    const span = innermostSpan(ordered, offset);
    if (!span) return { column, control: null };
    if (!cache.has(span)) cache.set(span, scanBody(code, masked, lineOf, span));
    return { column, control: cache.get(span).at(offset) };
  };
}

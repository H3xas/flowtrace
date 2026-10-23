/**
 * The C# side of the control evidence: for every call site in a method body, the frames
 * that hold it, whether an `await` heads it, and whether it starts a task that a later join
 * names.
 *
 * The scan reads the masked text — comments and literals blanked, offsets unchanged — and
 * copies a frame's own head out of the source, so a reader sees the construct as it was
 * written. Offsets are absolute in the file, so the passes that already produce facts ask
 * for their evidence with the same offset they use for their line.
 *
 * This is a statement reader, not a compiler. A shape it cannot classify stays outside
 * every frame, and a body it cannot read gets `control: null`, so the projection reports
 * the body as unreadable rather than inventing an order.
 */
import { frameId } from '../control-evidence.js';

const MAX_TEXT = 120;

function isIdentPart(ch) {
  return /[A-Za-z0-9_]/.test(ch || '');
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

/** The index just past the statement that starts at `start`, or `limit` when it never ends. */
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

/** The leftmost character of the member chain whose call parenthesis is `paren`. */
function chainStart(masked, paren, limit) {
  let start = paren;
  let i = paren - 1;
  while (i >= limit) {
    const ch = masked[i];
    if (ch === ' ') {
      i -= 1;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch) || ch === '.' || ch === '?') {
      start = i;
      i -= 1;
      continue;
    }
    if (ch === '>') {
      let depth = 1;
      start = i;
      i -= 1;
      while (i >= limit && depth > 0) {
        if (masked[i] === '>') depth += 1;
        else if (masked[i] === '<') depth -= 1;
        start = i;
        i -= 1;
      }
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

function collapsedText(content, from, to) {
  return content
    .slice(from, to)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/**
 * Scan one method body. `at(offset)` answers for one call site, and every answer comes from
 * the same scan, so two calls of one body never see two readings of one frame.
 */
function scanMethod(content, masked, starts, method) {
  const begin = method.startIndex;
  const end = method.endIndex;
  if (typeof begin !== 'number' || typeof end !== 'number' || end <= begin) return null;

  const frames = [];
  const awaits = [];
  const tasks = [];
  const locals = new Map();
  const joins = [];

  const lineAt = (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const columnAt = (index) => index - starts[lineAt(index) - 1] + 1;

  const pushFrame = (frame, from, to) => {
    if (to > from) frames.push({ from, to, frame });
  };

  const headFrame = (kind, form, index, fields) => ({
    kind,
    form,
    id: frameId(form, lineAt(index), columnAt(index)),
    line: lineAt(index),
    column: columnAt(index),
    text: collapsedText(content, index, Math.min(end, index + MAX_TEXT)),
    ...fields,
  });

  /** The first index after `from` that closes the expression holding the operator at `from`. */
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
      if ((ch === '&' && masked[i + 1] === '&') || (ch === '|' && masked[i + 1] === '|')) return i;
      if (ch === '?' && masked[i + 1] === '?') return i;
    }
    return limit;
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

  const topLevelArrows = (from, to) => {
    const arrows = [];
    let depth = 0;
    for (let i = from; i < to; i += 1) {
      if (masked[i] === '(' || masked[i] === '[' || masked[i] === '{') depth += 1;
      else if (masked[i] === ')' || masked[i] === ']' || masked[i] === '}') depth -= 1;
      else if (depth === 0 && masked[i] === '=' && masked[i + 1] === '>' && masked[i - 1] !== '=') {
        arrows.push({ from: i, to: skipSpace(masked, i + 2, to) });
        i += 2;
      }
    }
    return arrows;
  };

  const scanSwitchExpression = (keyword, open, close) => {
    const arms = topLevelArrows(open + 1, close);
    arms.forEach((arrow, index) => {
      const stop = index + 1 < arms.length ? arms[index + 1].from : close;
      const frame = headFrame('arm', 'switch-expression', keyword, { arm: `arm ${index + 1}`, text: 'switch' });
      pushFrame(frame, arrow.to, stop);
      operatorScan(arrow.to, stop, []);
    });
  };

  const enclosingCallName = (index) => {
    let depth = 0;
    for (let i = index - 1; i >= begin; i -= 1) {
      const ch = masked[i];
      if (ch === ')' || ch === ']') depth += 1;
      else if (ch === '(' || ch === '[') {
        if (depth === 0) {
          if (ch === '(' && (isIdentPart(masked[i - 1]) || masked[i - 1] === '>')) {
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

  const scanCallback = (keywordIndex, form, paramsStart, bodyStart, bodyEnd) => {
    const frame = {
      kind: 'callback',
      form,
      id: frameId(form, lineAt(keywordIndex), columnAt(keywordIndex)),
      line: lineAt(keywordIndex),
      column: columnAt(keywordIndex),
      text: collapsedText(content, paramsStart, bodyStart),
      host: enclosingCallName(paramsStart),
    };
    pushFrame(frame, bodyStart, bodyEnd);
    if (masked[bodyStart] === '{') {
      const close = findMatching(masked, bodyStart, '{', '}', bodyEnd);
      if (close !== null) scanRegion(bodyStart + 1, close);
    } else {
      operatorScan(bodyStart, bodyEnd, [[bodyStart, bodyEnd]]);
    }
  };

  const lambdasIn = (from, to) => {
    const found = [];
    for (let i = from; i < to; i += 1) {
      if (masked.startsWith('delegate', i) && !isIdentPart(masked[i - 1])) {
        let open = -1;
        for (let k = i + 8; k < to; k += 1) {
          if (masked[k] === '{') {
            open = k;
            break;
          }
        }
        if (open !== -1) {
          const close = findMatching(masked, open, '{', '}', to);
          if (close !== null) {
            found.push({ index: i, form: 'anonymous-method', paramsStart: i, bodyStart: open, bodyEnd: close + 1 });
            i = close;
          }
        }
        continue;
      }
      if (masked[i] === '=' && masked[i + 1] === '>' && masked[i - 1] !== '=') {
        const paramsStart = parameterListStart(masked, i - 1, from);
        const bodyStart = skipSpace(masked, i + 2, to);
        if (masked[bodyStart] === '{') {
          const close = findMatching(masked, bodyStart, '{', '}', to);
          if (close !== null) {
            found.push({ index: i, form: 'lambda', paramsStart, bodyStart, bodyEnd: close + 1 });
            i = close;
          }
        } else if (bodyStart < to) {
          found.push({ index: i, form: 'lambda', paramsStart, bodyStart, bodyEnd: expressionEnd(bodyStart, to) });
          i = bodyStart;
        }
      }
    }
    return found;
  };

  const scanTry = (start, limit) => {
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
  };

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

  const scanSwitchStatement = (start, limit) => {
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
    const text = collapsedText(content, start, closeParen + 1);
    const closeArm = (from, to, arm) => {
      pushFrame({ ...headFrame('arm', 'switch', start, { arm, text }) }, from, to);
    };
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
        arm = collapsedText(content, i, colon).replace(/\s+/g, ' ');
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
  };

  const firstCallAt = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (masked[i] === '(' && (isIdentPart(masked[i - 1]) || masked[i - 1] === '>')) {
        return { chain: chainStart(masked, i, begin), paren: i };
      }
      if (masked[i] === ';') return null;
    }
    return null;
  };

  const collectDeclarations = (from, to) => {
    const declaration = /\b(var|Task(?:<[^<>]*>)?|ValueTask(?:<[^<>]*>)?)\s+([A-Za-z_]\w*)\s*=(?!=)\s*/g;
    const text = masked.slice(from, to);
    let match;
    while ((match = declaration.exec(text))) {
      const rhs = from + match.index + match[0].length;
      const awaited = masked.startsWith('await', rhs) && !isIdentPart(masked[rhs + 5]);
      const startRhs = awaited ? skipSpace(masked, rhs + 5, to) : rhs;
      const call = firstCallAt(startRhs, to);
      if (!call) continue;
      locals.set(match[2], {
        declaredTask: match[1] !== 'var',
        awaited,
        range: [call.chain, call.paren + 1],
        id: `${lineAt(call.chain)}:${columnAt(call.chain)}`,
      });
    }
  };

  function scanOrdinary(start, limit) {
    const stop = statementEnd(masked, start, limit);
    const opaque = [];
    for (const lambda of lambdasIn(start, stop)) {
      scanCallback(lambda.index, lambda.form, lambda.paramsStart, lambda.bodyStart, lambda.bodyEnd);
      opaque.push([lambda.index, lambda.bodyEnd]);
    }
    operatorScan(start, stop, opaque);
    collectDeclarations(start, stop);
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
          if (masked[k] === '(' && (isIdentPart(masked[k - 1]) || masked[k - 1] === '>')) {
            paren = k;
            break;
          }
        }
        if (paren !== -1) awaits.push({ from: i, to: paren + 1 });
        i += 4;
        continue;
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
        continue;
      }
      if (ch === 's' && masked.startsWith('switch', i) && !isIdentPart(masked[i - 1])) {
        const open = skipSpace(masked, i + 6, to);
        if (masked[open] === '{') {
          const close = findMatching(masked, open, '{', '}', to);
          if (close !== null) {
            scanSwitchExpression(i, open, close);
            i = close;
          }
        }
      }
    }
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
    const text = collapsedText(content, start, closeParen + 1);
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
      const elseFrame = { ...frame, arm: 'else' };
      pushFrame(elseFrame, elseStart, elseEnd);
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
    const text = collapsedText(content, start, closeParen + 1);
    const bodyStart = skipSpace(masked, closeParen + 1, limit);
    const bodyEnd = statementEnd(masked, bodyStart, limit);
    const frame = headFrame('loop', word, start, { text });
    pushFrame(frame, word === 'foreach' ? bodyStart : start, bodyEnd);
    scanStatement(bodyStart, bodyEnd);
    return bodyEnd;
  }

  function scanDo(start, limit) {
    const bodyStart = skipSpace(masked, start + 2, limit);
    const bodyEnd = statementEnd(masked, bodyStart, limit);
    pushFrame(headFrame('loop', 'do', start, { text: 'do' }), start, bodyEnd);
    scanStatement(bodyStart, bodyEnd);
    return bodyEnd;
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
    if (word === 'for' || word === 'foreach' || word === 'while') return scanLoop(word, i, limit);
    if (word === 'do') return scanDo(i, limit);
    if (word === 'switch') return scanSwitchStatement(i, limit);
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

  function collectJoins() {
    const bodyText = masked.slice(begin, end);
    const awaitLocal = /\bawait\s+([A-Za-z_]\w*)\s*(?=[;)])/g;
    let match;
    while ((match = awaitLocal.exec(bodyText))) {
      const local = locals.get(match[1]);
      if (!local) continue;
      const index = begin + match.index;
      joins.push({ form: 'await', index, id: `${lineAt(index)}:${columnAt(index)}`, tasks: [local.id] });
    }
    const when = /\bTask\s*\.\s*When(All|Any)\s*\(/g;
    while ((match = when.exec(bodyText))) {
      const openParen = begin + match.index + match[0].length - 1;
      const closeParen = findMatching(masked, openParen, '(', ')', end);
      if (closeParen === null) continue;
      const index = begin + match.index;
      const argText = masked.slice(openParen + 1, closeParen);
      const ids = [];
      const direct = [];
      const callRe = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g;
      let callMatch;
      while ((callMatch = callRe.exec(argText))) {
        const paren = openParen + 1 + callMatch.index + callMatch[0].length - 1;
        const chain = chainStart(masked, paren, openParen + 1);
        const id = `${lineAt(chain)}:${columnAt(chain)}`;
        direct.push({ range: [chain, paren + 1], id });
        ids.push(id);
      }
      for (const [name, local] of locals) {
        if (new RegExp(`\\b${name}\\b`).test(argText)) ids.push(local.id);
      }
      joins.push({ form: `Task.When${match[1]}`, index, id: `${lineAt(index)}:${columnAt(index)}`, tasks: ids, direct });
    }
    const discard = /\b_\s*=\s*/g;
    while ((match = discard.exec(bodyText))) {
      const rhs = begin + match.index + match[0].length;
      const call = firstCallAt(rhs, end);
      if (!call) continue;
      tasks.push({
        range: [call.chain, call.paren + 1],
        task: { id: `${lineAt(call.chain)}:${columnAt(call.chain)}`, local: null, join: null },
      });
    }
  }

  scanRegion(begin, end);
  collectJoins();

  for (const [name, local] of locals) {
    if (local.awaited) continue;
    const join = joins.find((candidate) => candidate.tasks.includes(local.id));
    if (!join && !local.declaredTask) continue;
    tasks.push({
      range: local.range,
      task: {
        id: local.id,
        local: name,
        join: join
          ? {
              id: join.id,
              form: join.form,
              line: lineAt(join.index),
              column: columnAt(join.index),
              tasks: join.tasks,
            }
          : null,
      },
    });
  }
  for (const join of joins) {
    for (const direct of join.direct || []) {
      tasks.push({
        range: direct.range,
        task: {
          id: direct.id,
          local: null,
          join: { id: join.id, form: join.form, line: lineAt(join.index), column: columnAt(join.index), tasks: join.tasks },
        },
      });
    }
  }

  const normalize = (offset) => {
    let index = offset;
    while (index < end && /\s/.test(masked[index])) index += 1;
    if (masked.startsWith('await', index) && !isIdentPart(masked[index + 5])) {
      index = skipSpace(masked, index + 5, end);
    }
    if (masked.startsWith('this.', index)) index += 5;
    return index;
  };

  const at = (offset) => {
    const index = normalize(offset);
    const seen = new Set();
    const path = frames
      .filter((entry) => entry.from <= index && index < entry.to)
      .sort((a, b) => a.from - b.from || b.to - a.to)
      .map((entry) => entry.frame)
      .filter((frame) => {
        if (seen.has(frame.id)) return false;
        seen.add(frame.id);
        return true;
      });
    const control = { path };
    if (awaits.some((range) => range.from <= offset && offset < range.to)) control.await = true;
    const task = tasks.find((entry) => entry.range[0] <= index && index < entry.range[1]);
    if (task) control.task = task.task;
    return control;
  };

  return { at };
}

/** Build the per-file reader the call emitters query with their own call offset. */
export function buildFileControl(content, masked, starts, methodFrames) {
  const cache = new WeakMap();
  const known = new Set(methodFrames);
  return (method, offset) => {
    const line = lineOf(starts, offset);
    const column = offset - starts[line - 1] + 1;
    if (!method || !known.has(method)) return { column, control: null };
    if (!cache.has(method)) cache.set(method, scanMethod(content, masked, starts, method));
    const scanner = cache.get(method);
    if (!scanner) return { column, control: null };
    return { column, control: scanner.at(offset) };
  };
}

function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

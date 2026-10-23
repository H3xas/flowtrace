/**
 * The backend extractor resolves the line of an offset from a line-start index rather than
 * by counting terminators from the start of the text. The two models have to agree at every
 * offset, or a fact moves to a neighbouring line as soon as the file mixes terminators: C#
 * ends a line on LF, on CRLF and on a lone CR, and a CRLF advances the count only on its LF,
 * so a text carrying all three is the one that tells the models apart.
 *
 * This imports `lineAt` from `lib/` rather than driving the CLI: the lookup is pure and the
 * CLI already pins its output through the seed goldens, so a direct call covers every offset
 * of every terminator mix at a fraction of the cost.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lineAt } from '../lib/extract/backend.js';

/** The line of each offset under the counting rule the extractor used before the index:
 * one line more for each LF, and for each CR with no LF after it. */
function scanLines(text) {
  const lines = [];
  let line = 1;
  for (let index = 0; index <= text.length + 1; index += 1) {
    lines.push(line);
    if (text[index] === '\n') line += 1;
    else if (text[index] === '\r' && text[index + 1] !== '\n') line += 1;
  }
  return lines;
}

function assertEveryOffset(text) {
  const lines = scanLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    assert.equal(lineAt(text, index), lines[index], `text ${JSON.stringify(text)} at offset ${index}`);
  }
}

const TERMINATOR_ORDERS = [
  ['\n', '\r\n', '\r'],
  ['\n', '\r', '\r\n'],
  ['\r\n', '\n', '\r'],
  ['\r\n', '\r', '\n'],
  ['\r', '\n', '\r\n'],
  ['\r', '\r\n', '\n'],
];

const TEXTS = [
  '',
  'a',
  'a\nb',
  'a\nb\n',
  'a\r\nb',
  'a\r\nb\r\n',
  'a\rb',
  'a\rb\r',
  'a\r\r\nb',
  'a\r\r\nb\r\r\n',
  'a\r\n\n\rb\r',
  'aé\r\nb𝄞\rc\r',
  ...TERMINATOR_ORDERS.map(([first, second, third]) => `a${first}b${second}c${third}d`),
  ...TERMINATOR_ORDERS.map(([first, second, third]) => `a${first}b${second}c${third}`),
];

test('Backend line index AC-1: every offset resolves to the line the counting scan gives it', () => {
  for (const text of TEXTS) assertEveryOffset(text);
});

test('Backend line index AC-1: alternating texts of equal length each answer for their own text', () => {
  const first = 'a\r\nb\r\nc';
  const second = 'a\rb\r\r\nc';
  assert.equal(first.length, second.length);

  const firstLines = scanLines(first);
  const secondLines = scanLines(second);
  for (let index = 0; index < firstLines.length; index += 1) {
    assert.equal(lineAt(first, index), firstLines[index], `first text at offset ${index}`);
    assert.equal(lineAt(second, index), secondLines[index], `second text at offset ${index}`);
  }
});

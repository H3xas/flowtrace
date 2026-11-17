/**
 * The output a walk gives once its caller gates are taken away: the dependency view of a web
 * or mobile start has to equal the plain output after this, and nothing else may differ.
 */

const GATE_LINE = /^[│ ]*◇ /;

/** Text output without its gate lines and its caller case block. */
export function withoutGateLines(text) {
  const out = [];
  let inCases = false;
  for (const line of text.split('\n')) {
    if (/^caller cases \(\d+\):$/.test(line)) {
      inCases = true;
      continue;
    }
    if (inCases) {
      if (line === '') inCases = false;
      continue;
    }
    if (!GATE_LINE.test(line)) out.push(line);
  }
  return out.join('\n');
}

/** A parsed `trace --json` document without `callerGates` on its nodes and without `callerCases`. */
export function withoutGateFields(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.nodes)) return doc;
  const { callerCases, ...rest } = doc;
  return { ...rest, nodes: doc.nodes.map(({ callerGates, ...node }) => node) };
}

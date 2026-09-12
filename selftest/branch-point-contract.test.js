/**
 * A file may mix line terminators: C# ends a line on CR, on LF and on CRLF alike, and a
 * file written by a tool that emitted CR CR LF carries stray CRs that only one of those
 * three rules sees. `WidgetLedgerRepository.cs` in the corpus is stored that way on purpose
 * (its `.gitattributes` entry keeps the repository's eol normalisation off it), so this
 * pins what such a file must yield: every live branch, none of them resolved onto some
 * other line's text and dropped. The two branches below sit exactly as far above their own
 * closing brace as the stray CRs above them shift the numbering, so they are the two that
 * go missing first when the line models disagree.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyCorpus, extract } from './helpers.js';

const LEDGER = 'src/Repositories/WidgetLedgerRepository.cs';

test('a mixed-terminator file yields every branch point, not just the ones before the stray CRs', (t) => {
  const dir = copyCorpus(t);
  extract(dir);

  const factSet = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'api.json'), 'utf8'));
  const branches = factSet.facts.filter((f) => f.type === 'branch_point' && f.file === LEDGER);

  assert.equal(
    branches.length,
    4,
    `expected 4 branch points in ${LEDGER}, got ${branches.length}: ${JSON.stringify(branches.map((f) => f.text))}`,
  );

  for (const text of ['if (!removed)', 'if (!archived)']) {
    assert.ok(
      branches.some((f) => f.text === text),
      `expected a branch point whose text is ${JSON.stringify(text)}`,
    );
  }

  const byText = new Map(branches.map((f) => [`${f.method}:${f.text}`, f]));
  assert.equal(byText.get('RemoveEntry:if (!removed)').line, 56);
  assert.equal(byText.get('ArchiveEntry:if (!archived)').line, 73);
});

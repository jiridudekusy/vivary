// The npm package carries its own copies of the repository's README and
// LICENSE (npm takes them from the package dir); they must not drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const f of ['README.md', 'LICENSE']) {
  test(`cli/${f} is a copy of the repository's`, () => {
    assert.equal(fs.readFileSync(path.join(cli, f), 'utf8'), fs.readFileSync(path.join(cli, '..', f), 'utf8'),
      `copy it: cp ${f} cli/${f}`);
  });
}

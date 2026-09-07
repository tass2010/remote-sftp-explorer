/**
 * Documentation invariants.
 *
 * docs/02-architecture.md claims that every architectural invariant is proven by a named
 * test. That claim is itself an invariant, so it is checked here: an `enforced-by:` tag
 * pointing at a file that does not exist is exactly the sort of quietly-false statement that
 * made the previous documentation set untrustworthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const docsRoot = path.join(repoRoot, 'docs');

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) found.push(full);
  }
  return found;
}

test('every enforced-by tag names a test file that exists', () => {
  const pattern = /enforced-by:\s*`?([^\s`|]+)`?/g;
  let tagCount = 0;

  for (const doc of markdownFiles(docsRoot)) {
    const text = readFileSync(doc, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const target = match[1];
      if (target === undefined) continue;
      tagCount += 1;

      // A tag may name a file or a glob-ish directory prefix such as `pkg/test/**`.
      const cleaned = target.replace(/\/?\*+$/, '');
      const candidates = [
        path.join(repoRoot, cleaned),
        path.join(repoRoot, 'src', 'packages', cleaned)
      ];
      assert.ok(
        candidates.some((candidate) => existsSync(candidate)),
        `${path.relative(repoRoot, doc)} claims "enforced-by: ${target}", but no such file ` +
          'or directory exists. Either write the test or mark the claim [unenforced].'
      );
    }
  }

  assert.ok(tagCount > 0, 'no enforced-by tags found; the documentation contract is not in use');
});

test('no document references a deleted predecessor document', () => {
  // The six superseded documents were removed in the 0.3.0 rebuild. A dangling link to one of
  // them would send a reader looking for guidance that no longer exists.
  const removed = [
    'remote-sftp-explorer-detailed-design.md',
    'engineering-review-2026-07-14.md',
    'optimization-review-2026-07-21.md',
    'remediation-review-2026-08-30.md',
    'phase-0-test-plan.md',
    'tasks-eng-review-20260714.jsonl'
  ];
  for (const doc of markdownFiles(docsRoot)) {
    const text = readFileSync(doc, 'utf8');
    for (const name of removed) {
      assert.ok(
        !text.includes(name),
        `${path.relative(repoRoot, doc)} links to the removed document ${name}.`
      );
    }
  }
});

test('every ADR carries a date and a status', () => {
  const adrDir = path.join(docsRoot, 'adr');
  const adrs = readdirSync(adrDir).filter((entry) => entry.endsWith('.md'));
  assert.ok(adrs.length > 0, 'no ADRs found');
  for (const adr of adrs) {
    const text = readFileSync(path.join(adrDir, adr), 'utf8');
    assert.match(text, /\*\*Date:\*\*/, `${adr} has no Date field`);
    assert.match(text, /\*\*Status:\*\*/, `${adr} has no Status field`);
  }
});

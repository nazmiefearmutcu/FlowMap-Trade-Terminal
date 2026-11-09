// Unit tests for the e2e skip and flake budget (checkBudget.mjs). Run by ci.yml's
// release-tooling job with: node --test client/tests/reporters/checkBudget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectTests, evaluate, testKey } from './checkBudget.mjs';

function report(...specs) {
  return {
    suites: [{
      title: 'smooth-zoom.spec.ts',
      specs: specs.map(([title, status, project = 'chromium']) => ({
        title,
        tests: [{ projectName: project, status, results: [{}] }],
      })),
    }],
  };
}

test('collectTests joins nested suite titles and keeps the project and status', () => {
  const nested = {
    suites: [{
      title: 'a.spec.ts',
      suites: [{ title: 'outer', specs: [{ title: 'inner', tests: [{ projectName: 'replay', status: 'flaky', results: [{}, {}] }] }] }],
    }],
  };
  assert.deepEqual(collectTests(nested), [
    { title: 'a.spec.ts > outer > inner', project: 'replay', status: 'flaky', attempts: 2 },
  ]);
});

test('testKey qualifies the title with its project when there is one', () => {
  assert.equal(testKey({ title: 'x', project: 'chromium' }), 'x [chromium]');
  assert.equal(testKey({ title: 'x', project: '' }), 'x');
});

test('a skip named in the budget passes', () => {
  const budget = { expectedSkipped: ['smooth-zoom.spec.ts > one [chromium]'], maxFlaky: 0 };
  const result = evaluate(report(['one', 'skipped']), budget);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.stale, []);
});

test('a new skip fails even when the skip count is unchanged', () => {
  const budget = { expectedSkipped: ['smooth-zoom.spec.ts > one [chromium]'] };
  const result = evaluate(report(['two', 'skipped']), budget);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /not named in the budget: smooth-zoom\.spec\.ts > two \[chromium\]/);
  assert.deepEqual(result.stale, ['smooth-zoom.spec.ts > one [chromium]']);
});

test('a skip budgeted for one project does not cover the same title in another', () => {
  const budget = { expectedSkipped: ['smooth-zoom.spec.ts > one [chromium]'] };
  const result = evaluate(report(['one', 'skipped', 'replay']), budget);
  assert.equal(result.unexpected.length, 1);
  assert.match(result.problems[0], /one \[replay\]/);
});

test('no budget means no skip is allowed', () => {
  const result = evaluate(report(['one', 'skipped']), {});
  assert.equal(result.problems.length, 1);
});

test('a budget entry that never skips is reported as stale, not as a failure', () => {
  const result = evaluate(report(['one', 'passed']), { expectedSkipped: ['smooth-zoom.spec.ts > gone [chromium]'] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.stale, ['smooth-zoom.spec.ts > gone [chromium]']);
});

test('flaky tests keep a count budget', () => {
  const flaky = report(['a', 'flaky'], ['b', 'flaky']);
  assert.equal(evaluate(flaky, { maxFlaky: 2 }).problems.length, 0);
  const over = evaluate(flaky, { maxFlaky: 1 });
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /flaky e2e tests 2 exceed the budget of 1/);
});

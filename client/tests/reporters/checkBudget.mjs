// CI gate for the e2e suite: fail when skipped or flaky tests exceed the budget.
//
//   node tests/reporters/checkBudget.mjs <results.json> <budget.json>
//
// <results.json> is Playwright's JSON reporter output (PLAYWRIGHT_JSON_OUTPUT_NAME).
// <budget.json> is committed next to this script: { "expectedSkipped": [names], "maxFlaky": n }.
// A skipped test is only acceptable when the budget names it; the count is the
// gate, and every skipped and flaky title is printed so the set is reviewable.
// Unexpected failures already fail `playwright test` itself.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Walk Playwright's nested suites and collect every test with its outcome. */
export function collectTests(report) {
  const tests = [];
  const visit = (suite, parents) => {
    const titles = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({
          title: [...titles, spec.title].join(' > '),
          project: test.projectName ?? '',
          status: test.status ?? 'unknown',
          attempts: (test.results ?? []).length,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  };
  for (const suite of report.suites ?? []) visit(suite, []);
  return tests;
}

/** The budget key of a test: its full title, qualified by its Playwright project. */
export function testKey(test) {
  return test.project ? `${test.title} [${test.project}]` : test.title;
}

/**
 * Compare the run with the committed budget. Skips are a set comparison: every
 * skipped test must be named in budget.expectedSkipped, so a new skip fails the job
 * even when the total stays the same. Budget entries that no longer skip are
 * returned as `stale` so the list can be pruned. Flaky tests keep a count budget.
 */
export function evaluate(report, budget) {
  const tests = collectTests(report);
  const skipped = tests.filter((test) => test.status === 'skipped');
  const flaky = tests.filter((test) => test.status === 'flaky');
  const expected = new Set(Array.isArray(budget.expectedSkipped) ? budget.expectedSkipped : []);
  const skippedKeys = new Set(skipped.map(testKey));
  const unexpected = skipped.filter((test) => !expected.has(testKey(test)));
  const stale = [...expected].filter((key) => !skippedKeys.has(key)).sort();
  const maxFlaky = Number.isInteger(budget.maxFlaky) ? budget.maxFlaky : 0;
  const problems = [];
  for (const test of unexpected) {
    problems.push(`skipped e2e test is not named in the budget: ${testKey(test)}`);
  }
  if (flaky.length > maxFlaky) {
    problems.push(`flaky e2e tests ${flaky.length} exceed the budget of ${maxFlaky}`);
  }
  return { tests, skipped, flaky, unexpected, stale, problems };
}

function main(argv) {
  const [resultsPath, budgetPath] = argv;
  if (!resultsPath || !budgetPath) {
    console.error('usage: node tests/reporters/checkBudget.mjs <results.json> <budget.json>');
    return 2;
  }
  const report = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  const budget = JSON.parse(readFileSync(budgetPath, 'utf-8'));
  const { tests, skipped, flaky, stale, problems } = evaluate(report, budget);
  console.log(`e2e outcomes: ${tests.length} tests, ${skipped.length} skipped, ${flaky.length} flaky`);
  for (const test of skipped) console.log(`  skipped: ${testKey(test)}`);
  for (const test of flaky) console.log(`  flaky (${test.attempts} attempts): ${test.title}`);
  for (const key of stale) console.log(`  budget entry no longer skipped (remove it): ${key}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`e2e budget exceeded: ${problem}`);
    console.error(`Adjust client/tests/reporters/e2e-budget.json only with a reviewed reason.`);
    return 1;
  }
  console.log('e2e skip and flake budget: OK');
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}

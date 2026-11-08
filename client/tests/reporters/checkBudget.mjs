// CI gate for the e2e suite: fail when skipped or flaky tests exceed the budget.
//
//   node tests/reporters/checkBudget.mjs <results.json> <budget.json>
//
// <results.json> is Playwright's JSON reporter output (PLAYWRIGHT_JSON_OUTPUT_NAME).
// <budget.json> is committed next to this script: { "maxSkipped": n, "maxFlaky": n }.
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

/** Return { skipped, flaky, failures } lists plus a verdict. */
export function evaluate(report, budget) {
  const tests = collectTests(report);
  const skipped = tests.filter((test) => test.status === 'skipped');
  const flaky = tests.filter((test) => test.status === 'flaky');
  const maxSkipped = Number.isInteger(budget.maxSkipped) ? budget.maxSkipped : 0;
  const maxFlaky = Number.isInteger(budget.maxFlaky) ? budget.maxFlaky : 0;
  const problems = [];
  if (skipped.length > maxSkipped) {
    problems.push(`skipped e2e tests ${skipped.length} exceed the budget of ${maxSkipped}`);
  }
  if (flaky.length > maxFlaky) {
    problems.push(`flaky e2e tests ${flaky.length} exceed the budget of ${maxFlaky}`);
  }
  return { tests, skipped, flaky, problems };
}

function main(argv) {
  const [resultsPath, budgetPath] = argv;
  if (!resultsPath || !budgetPath) {
    console.error('usage: node tests/reporters/checkBudget.mjs <results.json> <budget.json>');
    return 2;
  }
  const report = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  const budget = JSON.parse(readFileSync(budgetPath, 'utf-8'));
  const { tests, skipped, flaky, problems } = evaluate(report, budget);
  console.log(`e2e outcomes: ${tests.length} tests, ${skipped.length} skipped, ${flaky.length} flaky`);
  for (const test of skipped) console.log(`  skipped: ${test.title}${test.project ? ` [${test.project}]` : ''}`);
  for (const test of flaky) console.log(`  flaky (${test.attempts} attempts): ${test.title}`);
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

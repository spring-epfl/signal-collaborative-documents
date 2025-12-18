import { AutomergeFactory } from './factory.js'
import { runBenchmarks, writeBenchmarkResultsToFile } from '../../js-lib/index.js'
import { webcrypto } from 'crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const benchmarkNames = ['b1-signal', 'b2-signal', 'b3-signal', 'b4-large-edits']

;(async () => {
  const suite = process.argv[2]  
  if (suite && !benchmarkNames.includes(suite)) {
    console.error(`Invalid suite: ${suite}. Expected one of ${benchmarkNames.join(", ")}.`)
    process.exit(1)
  }
  const suiteFilter = suite ? (key) => key === suite || key.startsWith(suite) : () => true

  await runBenchmarks(new AutomergeFactory(), suiteFilter)
  writeBenchmarkResultsToFile('../results.json', /** @param {string} _testName */ _testName => true)
})()

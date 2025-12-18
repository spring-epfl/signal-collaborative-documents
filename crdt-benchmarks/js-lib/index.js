import { runBenchmarkB1Signal } from './s1-signal.js'
import { runBenchmarkB2Signal } from './s2-signal.js'
import { runBenchmarkB2WS } from '../js-lib/s2-websocket.js'
import { runBenchmarkB3Signal } from '../js-lib/s3-signal.js'
import { runBenchmarkB4 } from './s4-large-edits.js'
import { CrdtFactory } from './utils.js' // eslint-disable-line
// import { runBenchmarkB4 } from './b4.js'

export * from './s1-signal.js'
export * from './s2-signal.js'
export * from './s3-signal.js'
export * from './b4-editing-trace.js'
export * from './s4-large-edits.js'
export * from './utils.js'

/**
 * @param {CrdtFactory} crdtFactory
 * @param {function(string):boolean} testFilter
 */
export const runBenchmarks = async (crdtFactory, testFilter) => {
  if (testFilter("b1-signal")) {
    await runBenchmarkB1Signal(crdtFactory, testFilter)
  }
  if (testFilter("b2-signal")) {
    await runBenchmarkB2Signal(crdtFactory, testFilter)
  }
  if (testFilter("b3-signal")) {
    await runBenchmarkB3Signal(crdtFactory, testFilter)
  }
  if (testFilter("b4-large-edits")) {
    await runBenchmarkB4(crdtFactory, testFilter)
  }

  // await runBenchmarkB2WS(crdtFactory, testFilter)
}

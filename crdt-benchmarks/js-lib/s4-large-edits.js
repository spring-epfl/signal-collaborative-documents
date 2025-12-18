import { setBenchmarkResult, gen, benchmarkTime, logMemoryUsed, getMemUsed, runBenchmark } from './utils.js'
import { writeFileSync } from 'fs'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as t from 'lib0/testing'
import { CrdtFactory, AbstractCrdt } from './index.js' // eslint-disable-line

const SIZES = [1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000]

// Collected per-benchmark rows for CSV output
const csvRows = []

/**
 * @param {CrdtFactory} crdtFactory
 * @param {function(string):boolean} filter
 */
export const runBenchmarkB4 = async (crdtFactory, filter) => {
  /**
   * Helper function to run a benchmark.
   *
   * @template T
   * @param {string} id name of the benchmark e.g. "[B1.1] Description"
   * @param {Array<T>} inputData
   * @param {function(AbstractCrdt, T, number):void} changeFunction Is called on every element in inputData
   * @param {function(AbstractCrdt, AbstractCrdt):void} check Check if the benchmark result is correct (all clients end up with the expected result)
   */
  const benchmarkTemplate = (id, inputData, changeFunction, check) => {
    let encodedState = null
    const doc2 = crdtFactory.create(() => {})

    // Collect per-run metrics
    let localOpTimeMs = 0
    let remoteApplyTimeMs = 0
    let parseTimeMs = 0
    let totalUpdateBytes = 0
    let updateCount = 0

    {
      const doc1Updates = []
      const doc1 = crdtFactory.create(update => { doc1Updates.push(update) })

      benchmarkTime(crdtFactory.getName(), `${id} (time)`, () => {
        for (let i = 0; i < inputData.length; i++) {
          const t0 = Date.now()
          changeFunction(doc1, inputData[i], i)
          localOpTimeMs += (Date.now() - t0)
        }

        // Apply generated updates to doc2 and time incorporation
        for (let i = 0; i < doc1Updates.length; i++) {
          const u = doc1Updates[i]
          totalUpdateBytes += u.length
          updateCount++
          const t0 = Date.now()
          doc2.applyUpdate(u)
          remoteApplyTimeMs += (Date.now() - t0)
        }

        check(doc1, doc2)
      })

      // Keep existing summary results for console/summary tables (if used elsewhere)
      const avgUpdateSize = updateCount === 0 ? 0 : math.round(totalUpdateBytes / updateCount)
      setBenchmarkResult(crdtFactory.getName(), `${id} (avgUpdateSize)`, `${avgUpdateSize} bytes`)

      benchmarkTime(crdtFactory.getName(), `${id} (encodeTime)`, () => {
        encodedState = doc1.getEncodedState()
      })
      // @ts-ignore
      const documentSize = encodedState.length
      setBenchmarkResult(crdtFactory.getName(), `${id} (docSize)`, `${documentSize} bytes`)

      // Push a CSV row for this benchmark run
      // Columns: crdt, benchmark, editSize, localOpTimeMs, remoteApplyTimeMs, parseTimeMs, updateCount, totalUpdateBytes, avgUpdateBytes
      const match = /length\s+(\d+)/.exec(id)
      const editSize = match ? Number(match[1]) : ''
      const row = {
        crdt: crdtFactory.getName(),
        benchmark: id,
        editSize,
        localOpTimeMs,
        remoteApplyTimeMs,
        parseTimeMs,
        updateCount,
        totalUpdateBytes,
        avgUpdateBytes: avgUpdateSize
      }
      csvRows.push(row)
    }

    benchmarkTime(crdtFactory.getName(), `${id} (parseTime)`, () => {
      const startHeapUsed = getMemUsed()
      const t0 = Date.now()
      const doc = crdtFactory.load(() => {}, encodedState)
      parseTimeMs += (Date.now() - t0)
      // Store on the last pushed row for this benchmark
      csvRows[csvRows.length - 1].parseTimeMs = parseTimeMs
      check(doc2, doc)
      logMemoryUsed(crdtFactory.getName(), id, startHeapUsed)
    })
  }

  // Run benchmarks for increasing edit sizes and write CSV at the end
  // NOTE: `filter` here is the suite selector (e.g. matches "b4-large-edits"),
  // not a per-benchmark selector, so we must not pass it into `runBenchmark`.
  const runAllBenchmarks = () => true

  for (const size of SIZES) {
    await runBenchmark(`[B4] Insert string of length ${size}`, runAllBenchmarks, benchmarkName => {
      const string = prng.word(gen, size, size)
      benchmarkTemplate(
        benchmarkName,
        [string],
        (doc, s, i) => { doc.insertText(i, s) },
        (doc1, doc2) => {
          t.assert(doc1.getText() === doc2.getText())
          t.assert(doc1.getText() === string)
        }
      )
    })
  }

  // Output CSV
  {
    const header = [
      'crdt',
      'benchmark',
      'editSize',
      'localOpTimeMs',
      'remoteApplyTimeMs',
      'parseTimeMs',
      'updateCount',
      'totalUpdateBytes',
      'avgUpdateBytes'
    ].join(',')

    const rows = [header]
    for (const r of csvRows) {
      rows.push([
        r.crdt,
        JSON.stringify(r.benchmark),
        r.editSize,
        r.localOpTimeMs,
        r.remoteApplyTimeMs,
        r.parseTimeMs,
        r.updateCount,
        r.totalUpdateBytes,
        r.avgUpdateBytes
      ].join(','))
    }

    console.log('\n' + rows.join('\n'))
    writeFileSync(new URL('../../benchmark_data/s4-large-edits.csv', import.meta.url), rows.join('\n'))
  }
}
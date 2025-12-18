import { setBenchmarkResult, gen, N, benchmarkTime, runBenchmark, logMemoryUsed, getMemUsed } from './utils.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import { createMutex } from 'lib0/mutex'
import * as t from 'lib0/testing'
import { CrdtFactory, AbstractCrdt } from './index.js' // eslint-disable-line
import { EventSource } from 'eventsource';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { deserializeMessage, serializeMessage } from './utils.js';

global.EventSource = EventSource;

import { sendMessage } from './signal-api.js';
import { writeFileSync } from 'fs';

const initText = prng.word(gen, 100, 100)

const groupId = 'wTNY8teX//CGUwj/7wXVQSqnJqVkxmWaessV0HPkSlI=';
const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || 'http://localhost:8080';

const account1 = "+41782255248";
const account2 = "+41783227908";

let updateIdCounter = 0;
const senderMetrics = new Map();
let updatesSize = 0;
const signalMetrics = new Map(); // id -> { envelopeTimestamp, receivingTimestamp }
const receiverMetrics = new Map();


// If this module is loaded in a Worker thread, auto-start the SSE setup
if (!isMainThread) {
  // Worker thread: set up the SSE listener
  console.log('[B2][WORKER] Setting up SSE listener');
  let es = new EventSource(`${SIGNAL_SERVER_URL}/api/v1/events`);
  es.addEventListener('receive', async e => {
    const receivingTimestamp = Date.now();
    const ev = JSON.parse(e.data);
    const info = ev.envelope?.dataMessage?.groupInfo;
    const msgBytes = ev.envelope?.dataMessage?.message;
    if (!info?.groupId || info.groupId !== groupId) return;
    if (info.type === 'DELIVER') {
      const serverReceivedTimestamp = ev.envelope?.serverReceivedTimestamp;
      const serverDeliveredTimestamp = ev.envelope?.serverDeliveredTimestamp;
      const envelopeTimestamp = ev.envelope.dataMessage.timestamp;
      const { id, update } = deserializeMessage(msgBytes);
      // Forward metrics to the main thread for CSV collection
      console.log(`[B2][WORKER] Sending ${id}, ${receivingTimestamp}, ${serverReceivedTimestamp}, ${serverDeliveredTimestamp}, ${envelopeTimestamp} to parent thread`);
      parentPort.postMessage({
        signalMetrics: { id, receivingTimestamp, serverReceivedTimestamp, serverDeliveredTimestamp, envelopeTimestamp }
      });
    }
  });
  // Signal the main thread that the listener is ready
  parentPort.postMessage('ok');

  // Listen for shutdown signal from main thread to gracefully close SSE and exit
  parentPort.on('message', msg => {
    if (msg && msg.cmd === 'shutdown') {
      try { if (es) { es.close(); es.removeAllListeners && es.removeAllListeners(); } } catch (_) { /* ignore */ }
      es = null;
      process.exit(0);
    }
  });
}

export const runBenchmarkB2Signal = async (crdtFactory, filter) => {
  if (isMainThread) {
    console.log('[B2][MAIN] Spawning worker for SSE listener');
    const worker = new Worker(new URL(import.meta.url), { type: 'module' });
    // Capture signal metrics forwarded from the worker thread
    worker.on('message', msg => {
      console.log(`[B2][MAIN] Received from worker: `, JSON.stringify(msg));
      if (msg && msg.signalMetrics) {
        const { id, receivingTimestamp, serverReceivedTimestamp, serverDeliveredTimestamp, envelopeTimestamp } = msg.signalMetrics;
        signalMetrics.set(id, { receivingTimestamp, serverReceivedTimestamp, serverDeliveredTimestamp, envelopeTimestamp });
      }
    });
    // Wait for worker to signal readiness, but don't let this consume the final 'exit' event.
    await new Promise((resolve, reject) => {
      const onReadyMessage = (msg) => {
        if (msg === 'ok') {
          console.log('[B2][MAIN] Worker ready, starting benchmarks');
          cleanup();
          resolve();
        } else if (msg && msg.error) {
          cleanup();
          reject(new Error(`Worker error: ${msg.error}`));
        } else {
          // ignore non-ready messages (e.g., metric frames)
        }
      };
      const onError = (err) => { cleanup(); reject(err); };
      const onEarlyExit = (code) => {
        cleanup();
        reject(new Error(`Worker exited before ready (code ${code})`));
      };
      const cleanup = () => {
        worker.removeListener('message', onReadyMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onEarlyExit);
      };
      worker.on('message', onReadyMessage);
      worker.once('error', onError);
      worker.once('exit', onEarlyExit);
    });
    // Now run the benchmarks in the main thread
    await runBenchmarkB2(crdtFactory, filter);

    // Tell the worker to shut down (closes SSE) and then wait for it to exit, but don't hang forever
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const timeout = setTimeout(async () => {
        // If the worker didn't exit in time, force terminate
        try { await worker.terminate(); } catch (_) { /* ignore */ }
        finish();
      }, Number(process.env.SIGNAL_WORKER_SHUTDOWN_TIMEOUT_MS || 1000));
      worker.once('exit', code => { clearTimeout(timeout); finish(); });
      worker.postMessage({ cmd: 'shutdown' });
    });
  }
}

/**
 * @param {CrdtFactory} crdtFactory
 * @param {function(string):boolean} filter
 */
export const runBenchmarkB2 = async (crdtFactory, filter) => {
  /**
   * @param {string} id
   * @param {function(AbstractCrdt):void} changeDoc1
   * @param {function(AbstractCrdt):void} changeDoc2
   * @param {function(AbstractCrdt, AbstractCrdt):void} check
   */
  const benchmarkTemplate = async (id, inputOps1, inputOps2, check) => {
    let encodedState = null
    updatesSize = 0
    const mux = createMutex()
    const doc1 = crdtFactory.create(update => mux(async () => {
      updatesSize += update.length;
      updateIdCounter++;
      const id = updateIdCounter;
      console.log(`[B2][USER1:${account1}] processing update #${id} (${update.length} bytes)`);
      const serializationTime = 0; // already serialized
      console.log(`[B2][USER1:${account1}] Sending message #${id}`);

      const sendingTimestamp = Date.now();
      sendMessage(account1, groupId, serializeMessage(id, update));

      const updateSize = update.length;
      senderMetrics.set(id, { sender: 0, serializationTime, sendingTimestamp, updateSize });

      const applyStart = Date.now();
      doc2.applyUpdate(update);
      const applyTime = Date.now() - applyStart;
      receiverMetrics.set(id, { applyTime });
    }))
    const doc2 = crdtFactory.create(update => mux(async () => {
      updatesSize += update.length;
      updateIdCounter++;
      const id = updateIdCounter;
      console.log(`[B2][USER2:${account2}] processing update #${id} (${update.length} bytes)`);
      const serializationTime = 0; // TODO

      const sendingTimestamp = Date.now();
      sendMessage(account2, groupId, serializeMessage(id, update));
      const updateSize = update.length;
      senderMetrics.set(id, { sender: 1, serializationTime, sendingTimestamp, updateSize });
      console.log(`[B2][USER2:${account2}] Sending message #${id}`);

      const applyStart = Date.now();
      doc1.applyUpdate(update);
      const applyTime = Date.now() - applyStart;
      receiverMetrics.set(id, { applyTime });
    }))

    // Initialize document
    doc1.insertText(0, initText)
    // Manually time the concurrent inserts, allowing event loop ticks so SSE events in the worker are processed
    const startTime = Date.now()

    let sentA = 0, sentB = 0;

    const senderALoop = (async () => {
      while (sentA < N) {
        const { insert: insert1 } = inputOps1[sentA++];
        const delay1 = Math.floor(Math.random() * 100) + 200; // 200–300 ms
        await new Promise(r => setTimeout(r, delay1));
        doc1.transact(() => doc1.insertText(0, insert1));
      }
    })();

    const senderBLoop = (async () => {
      while (sentB < N) {
        const { insert: insert2 } = inputOps2[sentB++];
        const delay2 = Math.floor(Math.random() * 300) + 100; // 100–400 ms
        await new Promise(r => setTimeout(r, delay2));
        const len2 = doc2.getText().length;
        doc2.transact(() => doc2.insertText(len2, insert2));
      }
    })();

    // Wait for both to finish 
    await Promise.all([senderALoop, senderBLoop]);
    // Wait for all Signal events to arrive (expected = 2 * N updates)
    const expected = 2 * N;
    while (signalMetrics.size < expected) {
      console.log(`[B2][${id}] Waiting for ${expected - signalMetrics.size} Signal events...`);
      await new Promise(res => setTimeout(res, 100));
    }
    check(doc1, doc2)
    const elapsed = Date.now() - startTime
    setBenchmarkResult(crdtFactory.getName(), `${id} (time)`, `${elapsed} ms`)
    const avgUpdateSize = math.round(updatesSize / 2)
    setBenchmarkResult(crdtFactory.getName(), `${id} (updateSize)`, `${avgUpdateSize} bytes`)
    benchmarkTime(crdtFactory.getName(), `${id} (encodeTime)`, () => {
      encodedState = doc1.getEncodedState()
    })

    benchmarkTime(crdtFactory.getName(), `${id} (parseTime)`, () => {
      const startHeapUsed = getMemUsed()
      // eslint-disable-next-line
      const doc = crdtFactory.load(() => { }, encodedState)
      check(doc, doc2)
      logMemoryUsed(crdtFactory.getName(), id, startHeapUsed)
    })
  }

  // Directly run the single benchmark without filtering
  const benchmarkName = '[B2-Signal] Concurrent non-overlapping edits';
  const initialLength = initText.length;
  const half = Math.floor(initialLength / 2);
  const genInput = (regionStart, regionEnd) => {
    const input = [];
    for (let i = 0; i < N; i++) {
      const index = prng.uint32(gen, regionStart, regionEnd);
      const len = 1; //prng.uint32(gen, 1, 10);
      const insert = prng.word(gen, len, len);
      input.push({ index, insert });
    }
    return input;
  };
  const input1 = genInput(0, half);
  const input2 = genInput(half, initialLength);
  await benchmarkTemplate(
    benchmarkName,
    input1,
    input2,
    (doc1, doc2) => {
      t.assert(doc1.getText() === doc2.getText());
    }
  );

  // Once all benchmarks have finished, yield to process SSE events, then write metrics to CSV
  await new Promise(resolve => {
    const check = () => {
      if (signalMetrics.size >= senderMetrics.size) {
        return resolve();
      }
      setTimeout(check, 10); // short poll delay
    };
    check();
  });
  {
    const header = [
      'id',
      'sender',
      'sendingTimestamp',
      'updateSize',
      'receivingTimestamp',
      'serverReceivedTimestamp',
      'serverDeliveredTimestamp',
      'envelopeTimestamp',
      'applyTime'
    ].join(',');
    const rows = [header];
    const allIds = new Set([
      ...senderMetrics.keys(),
      ...signalMetrics.keys(),
      ...receiverMetrics.keys()
    ]);
    for (const id of allIds) {
      const sm = senderMetrics.get(id) || {};
      const sgn = signalMetrics.get(id) || {};
      const rm = receiverMetrics.get(id) || {};
      rows.push([
        id,
        // sm.serializationTime ?? '',
        sm.sender ?? '',
        sm.sendingTimestamp ?? '',
        sm.updateSize ?? '',
        sgn.receivingTimestamp ?? '',
        sgn.serverReceivedTimestamp ?? '',
        sgn.serverDeliveredTimestamp ?? '',
        sgn.envelopeTimestamp ?? '',
        rm.applyTime ?? ''
      ].join(','));
    }
    console.log("\n");
    console.log(rows.join('\n'));
    writeFileSync(new URL('../../benchmark_data/s2-signal.csv', import.meta.url), rows.join('\n'));
  }
}

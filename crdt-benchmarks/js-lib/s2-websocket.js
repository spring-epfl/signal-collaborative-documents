// File: s2-websocket.js

import { setBenchmarkResult, gen, N, benchmarkTime, logMemoryUsed, getMemUsed } from './utils.js';
import * as prng from 'lib0/prng';
import * as math from 'lib0/math';
import { createMutex } from 'lib0/mutex';
import * as t from 'lib0/testing';
import { CrdtFactory, AbstractCrdt } from './index.js' // eslint-disable-line
import { writeFileSync } from 'fs';
import { Repo } from '@automerge/automerge-repo';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { Text } from '@automerge/automerge';
import { deserializeMessage, serializeMessage } from './utils.js';
import { Worker, isMainThread, parentPort } from 'worker_threads';

import * as NetAdapter from '@automerge/automerge-repo-network-websocket';
const NodeWSClientAdapter = NetAdapter.WebSocketClientAdapter;
if (!NodeWSClientAdapter) {
  throw new Error(
    'Expected NetAdapter.WebSocketClientAdapter to exist, found: ' +
    JSON.stringify(Object.keys(NetAdapter))
  );
}

// TODO: setup

if (!isMainThread) {
  // Worker thread: set up a listener for the websocket events
  // TODO: For each new event, record the receivingTimestamp, deserilize to get the ID, and 
  // parentPort.postMessage({receiverMetrics: { id, receivingTimestamp }});
  
  // Signal to the main thread that the listener is ready
  parentPort.postMessage('ok');
}

//
// This script benchmarks “applyTime” and WebSocket latency for two replicas
// concurrently applying non‐overlapping edits using Automerge.
// It creates an in‐process WebSocket server, connects two clients, and measures
// the time between sending an incremental update and receiving/applying it.
//

// Configuration
const initText = prng.word(gen, 100, 100); // Initial document content (100 chars)

// Counters and metrics
let updateIdCounter = 0;
const senderMetrics = new Map();   // Maps update ID → { sendingTimestamp, updateSize }
const receiverMetrics = new Map();  // Maps update ID → { networkLatency, applyTime, updateSize }

export const runBenchmarkB2WS = async (crdtFactory, filter) => {

  // 1. Create a Repo backed by a local FS store and the Automerge public sync server
  const storage = new NodeFSStorageAdapter('./repo-storage');
  const repo = new Repo({
    storage,
    network: [new WebSocketClientAdapter('wss://sync.automerge.org')]
  });

  // 2. Create/join a shared document URL
  const handle1 = await repo.create();
  const handle2 = await repo.find(handle1.url);
  console.log('[WS BENCHMARK] Connected to sync.automerge.org with doc URL:', handle1.url);

  // 3. Hook up send/receive metrics
  handle1.on('change', ({ change }) => {
    if (!change) return;
    updateIdCounter++;
    const id = updateIdCounter;
    const sendingTimestamp = Date.now();
    const updateSize = 0;
    senderMetrics.set(id, { sendingTimestamp, updateSize });
    change.id = id;
    console.log(`[1] sending id=${id} at ${sendingTimestamp}`);
  });

  handle2.on('change', ({ change }) => {
    if (!change) return;
    const receivingTimestamp = Date.now();
    const id = change.id;
    const { sendingTimestamp, updateSize } = senderMetrics.get(id) || {};
    const networkLatency = receivingTimestamp - sendingTimestamp;
    const applyTime = 0;
    receiverMetrics.set(id, { networkLatency, applyTime, updateSize });
    console.log(`[2] received id=${id} at ${receivingTimestamp} (latency=${networkLatency}ms)`);
  });

  // Mirror for handle1 receiving changes from handle2
  handle1.on('change', ({ change }) => {
    if (!change) return;
    const receivingTimestamp = Date.now();
    const id = change.id;
    const { sendingTimestamp, updateSize } = senderMetrics.get(id) || {};
    const networkLatency = receivingTimestamp - sendingTimestamp;
    const applyTime = 0;
    receiverMetrics.set(id, { networkLatency, applyTime, updateSize });
    console.log(`[1] received id=${id} at ${receivingTimestamp} (latency=${networkLatency}ms)`);
  });

  let encodedState = null
  let updatesSize = 0
  const mux = createMutex()

  // Removed creation of doc1 and doc2 per instructions

  // Initialize document
  await handle1.change(root => {
    root.text = new Text();
    for (let i = 0; i < initText.length; i++) {
      root.text.insertAt(i, initText[i]);
    }
  });
  // Wait briefly for handle2 to sync initial state
  await new Promise(res => setTimeout(res, 100));

  // Manually time the concurrent inserts, allowing event loop ticks so SSE events in the worker are processed
  const startTime = Date.now()

  let sentA = 0, sentB = 0;


  const senderALoop = (async () => {
    while (sentA < N) {
      const { insert: insert1 } = inputOps1[sentA++];
      const delay1 = Math.floor(Math.random() * 100) + 200; // 200–300 ms
      await new Promise(r => setTimeout(r, delay1));
      await handle1.change(root => {
        root.text.insertAt(0, insert1);
      });
    }
  })();

  const senderBLoop = (async () => {
    while (sentB < N) {
      const { insert: insert2 } = inputOps2[sentB++];
      const delay2 = Math.floor(Math.random() * 300) + 100; // 100–400 ms
      await new Promise(r => setTimeout(r, delay2));
      const currentText = handle2.doc.text.toString();
      const len2 = currentText.length;
      await handle2.change(root => {
        root.text.insertAt(len2, insert2);
      });
    }
  })();

  // Wait for both to finish (if you want to block until all N are sent)
  await Promise.all([senderALoop, senderBLoop]);
  // Wait for all Signal events to arrive (expected = 2 * N updates)
  const expected = 2 * N;
  while (receiverMetrics.size < expected) {
    console.log(`[${id}] Waiting for ${expected - receiverMetrics.size} Websocket events...`);
    await new Promise(res => setTimeout(res, 100));
  }
  t.assert(handle1.doc.text.toString() === handle2.doc.text.toString());
  const elapsed = Date.now() - startTime
  setBenchmarkResult(crdtFactory.getName(), `${id} (time)`, `${elapsed} ms`)
  const avgUpdateSize = math.round(updatesSize / 2)
  setBenchmarkResult(crdtFactory.getName(), `${id} (updateSize)`, `${avgUpdateSize} bytes`)
  benchmarkTime(crdtFactory.getName(), `${id} (encodeTime)`, () => {
    encodedState = handle1.doc.getEncodedState()
  })

  benchmarkTime(crdtFactory.getName(), `${id} (parseTime)`, () => {
    const startHeapUsed = getMemUsed()
    // eslint-disable-next-line
    const doc = crdtFactory.load(() => { }, encodedState)
    t.assert(doc.getText() === handle2.doc.text.toString())
    logMemoryUsed(crdtFactory.getName(), id, startHeapUsed)
  })


  // Directly run the single benchmark without filtering
  const benchmarkName = '[B2-Signal] Concurrent non-overlapping edits';
  const initialLength = initText.length;
  const half = Math.floor(initialLength / 2);
  const genInput = (regionStart, regionEnd) => {
    const input = [];
    for (let i = 0; i < N; i++) {
      const index = prng.uint32(gen, regionStart, regionEnd);
      const len = prng.uint32(gen, 1, 10);
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
      if (receiverMetrics.size >= senderMetrics.size) {
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
      'applyTime'
    ].join(',');
    const rows = [header];
    const allIds = new Set([
      ...senderMetrics.keys(),
      ...receiverMetrics.keys()
    ]);
    for (const id of allIds) {
      const sm = senderMetrics.get(id) || {};
      const rm = receiverMetrics.get(id) || {};
      rows.push([
        id,
        // sm.serializationTime ?? '',
        sm.sender ?? '',
        sm.sendingTimestamp ?? '',
        sm.updateSize ?? '',
        rm.receivingTimestamp ?? '',
        rm.applyTime ?? ''
      ].join(','));
    }
    console.log("\n");
    console.log(rows.join('\n'));
    writeFileSync(new URL('../s2-websocket.csv', import.meta.url), rows.join('\n'));
  }
}

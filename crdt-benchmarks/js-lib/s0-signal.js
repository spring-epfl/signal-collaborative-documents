import {
  setBenchmarkResult,
  gen,
  N,
  benchmarkTime,
  runBenchmark,
  logMemoryUsed,
  getMemUsed
} from './utils.js';
import * as prng from 'lib0/prng';
import * as math from 'lib0/math';
import { CrdtFactory, AbstractCrdt } from './index.js'; // eslint-disable-line
import { writeFileSync } from 'fs';
import { deserializeMessage, serializeMessage } from './utils.js';
import { sendMessage } from './signal-api.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);


const initText = prng.word(gen, 100, 100);
const groupId = 'wTNY8teX//CGUwj/7wXVQSqnJqVkxmWaessV0HPkSlI=';

const account1 = '+41782255248'; // User 1’s phone
const account2 = '+41783227908'; // User 2’s phone

let updateIdCounter = 0;
let updatesSize = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Utility to serialize a CRDT update and send it to Signal (account1).
 * We keep track of total bytes sent in `updatesSize`.
 */
async function sendAndRecordUpdate(crdtDoc, insertOp, senderAccount) {
  const thisUpdateId = ++updateIdCounter;
  crdtDoc.transact(() => {
    crdtDoc.insertText(...insertOp);
  });

  // The factory’s “onUpdate” callback stores the raw bytes here:
  const updateBytes = crdtDoc._lastUpdate;
  const updateSize = updateBytes.length;
  updatesSize += updateSize;

  const serializedMsg = serializeMessage(thisUpdateId, updateBytes);
  const sendingTimestamp = Date.now();

  // --- NEW: Use JSON-RPC instead of spawning a new process ---
  await sendMessage(senderAccount, groupId, serializedMsg);

  return {
    id: thisUpdateId,
    size: updateSize,
    sendingTimestamp
  };
}

export const runBenchmarkB1Signal = async (crdtFactory, filter) => {
  await runSequentialThenReceive(crdtFactory);
};

async function runSequentialThenReceive(crdtFactory) {
  // -------------------------
  // PHASE 1: User 1 (doc1)
  // -------------------------
  console.log('[PHASE 1] User 1: create doc, do N edits, and send each update');

  const doc1 = crdtFactory.create((updateBytes) => {
    doc1._lastUpdate = updateBytes;
  });

  // Initialize locally, then clone this exact history into doc2
  doc1.insertText(0, initText);
  doc1.
  const initialEncodedState = doc1.getEncodedState();

  const genInput = () => {
    const inputOps = [];
    for (let i = 0; i < N; i++) {
      const idx = prng.uint32(gen, 0, doc1.getText().length);
      const len = prng.uint32(gen, 1, 10);
      const substring = prng.word(gen, len, len);
      inputOps.push({ index: idx, insert: substring });
    }
    return inputOps;
  };
  const inputOpsList = genInput();

  const senderMetrics = [];
  for (let i = 0; i < N; i++) {
    const { index, insert } = inputOpsList[i];
    const { id, size, sendingTimestamp } = await sendAndRecordUpdate(
      doc1,
      [index, insert],
      account1
    );
    senderMetrics.push({ id, size, sendingTimestamp });
    // Optional progress indicator:
    process.stdout.write('.');
  }
  console.log(`[USER1:${account1}] Sent ${N} updates. Total bytes sent = ${updatesSize}`);

  // -------------------------
  // PHASE 2: User 2 (doc2) via one-shot signal-cli receive
  // -------------------------
  console.log(`[USER2:${account2}] Receiving updates from Signal and applying them`);

  // Fail-safe for polling so we don't loop forever when nothing matches our filter
  const MAX_IDLE_POLLS = 60; // ~60s with 1s sleeps
  let idlePolls = 0;

  // Create a fresh CRDT document for User 2:
  const doc2 = crdtFactory.load(() => { }, initialEncodedState);

  // We'll repeatedly invoke `signal-cli receive` until we've collected N updates.
  const receivedSoFar = new Map(); // id → raw update Uint8Array
  let totalReceiveTime = 0;

  while (receivedSoFar.size < N) {
    let batch = [];
    const start = Date.now();
    try {
      // Run one-shot receive with CLI:
      // signal-cli --output=json --config=$CONFIG -u $ACCOUNT receive --json --timeout 0 --max-messages N
      const { stdout } = await execFileAsync('signal-cli', [
        '--output', 'json',
        "--config=../../../signal-data/signal-multiaccount",
        '-u', account2,
        'receive',
        '--timeout', '0',
        '--max-messages', String(N)
      ]);
      console.log(stdout);
      const text = stdout.trim();
      if (!text) {
        // No messages available in this poll; wait and try again, with a fail-safe to avoid infinite loops
        console.log('→ No new messages in this poll');
        idlePolls++;
        if (idlePolls >= MAX_IDLE_POLLS) {
          console.log(`→ Giving up after ${MAX_IDLE_POLLS} idle polls`);
          break;
        }
        await sleep(1000);
        continue;
      }

      const lines = text.split(/\r?\n/);
      const events = [];
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          events.push(JSON.parse(s));
        } catch {
          // Ignore stray non-JSON lines instead of failing the whole batch
          console.warn('Non-JSON line from signal-cli receive:', s);
        }
      }

      // Map Signal envelopes -> our batch format
      batch = events
        .map((ev) => {
          const dm = ev?.envelope?.dataMessage;
          if (!dm) return null;
          if (dm?.groupInfo?.groupId !== groupId) return null;

          let raw;
          try {
            // Signal CLI typically exposes DataMessage.message as a STRING.
            // Our sender may have put base64 directly in the body, or JSON like {"data":"..."}.
            if (typeof dm.message === 'string') {
              // Try JSON first; if it fails, treat as plain base64.
              try {
                const inner = JSON.parse(dm.message);
                if (inner && typeof inner.data === 'string') {
                  raw = Buffer.from(inner.data, 'base64');
                } else if (inner && typeof inner.b64 === 'string') {
                  raw = Buffer.from(inner.b64, 'base64');
                } else {
                  // Not a recognized wrapper; assume the body itself is base64
                  raw = Buffer.from(dm.message, 'base64');
                }
              } catch {
                // Not JSON; assume base64 string
                raw = Buffer.from(dm.message, 'base64');
              }
            } else if (dm.message && typeof dm.message.data === 'string') {
              // Fallback in case message is already an object with a data field
              raw = Buffer.from(dm.message.data, 'base64');
            } else {
              return null;
            }
          } catch {
            return null;
          }

          // Create a Uint8Array view over exactly the bytes we decoded
          const u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          return { timestamp: dm.timestamp, rawBytes: u8 };
        })
        .filter(Boolean);
    } catch (e) {
      console.log(`→ receive failed (“${e.message}”), retrying in 1s…`);
      await sleep(1000);
      continue;
    }
    const end = Date.now();
    totalReceiveTime += end - start;

    if (batch.length > 0) {
      idlePolls = 0;
      console.log(`→ Received ${batch.length} message(s):`);
      for (const { timestamp, rawBytes } of batch) {
        const { id, update } = deserializeMessage(rawBytes);
        console.log(`   • [id=${id}, timestamp=${timestamp}, bytes=${update.length}]`);
        if (!receivedSoFar.has(id)) {
          receivedSoFar.set(id, update);
        }
      }
      console.log(`   Total collected so far: ${receivedSoFar.size}/${N}\n`);
    } else {
      // No new messages; wait a bit before retrying
      idlePolls++;
      if (idlePolls >= MAX_IDLE_POLLS) {
        console.log(`→ Giving up after ${MAX_IDLE_POLLS} idle polls with empty batches`);
        break;
      }
      await sleep(1000);
    }
  }

  console.log(`Collected ${receivedSoFar.size}/${N} updates (≈ ${totalReceiveTime} ms total receive time).\n`);

  // Now apply each update in ascending id order:
  const receiverMetrics = [];
  const sortedIds = Array.from(receivedSoFar.keys()).sort((a, b) => a - b);
  const totalApplyStart = Date.now();
  for (const id of sortedIds) {
    const updateBytes = receivedSoFar.get(id);
    const applyStart = Date.now();
    doc2.applyUpdate(updateBytes);
    const applyTime = Date.now() - applyStart;
    receiverMetrics.push({ id, applyTime });
  }
  const totalApplyEnd = Date.now();
  const totalApplyDuration = totalApplyEnd - totalApplyStart;

  // Verify final document equality:
  if (doc1.getText() !== doc2.getText()) {
    console.error('[ERROR] Final documents do not match!');
  } else {
    console.log('[SUCCESS] doc1 and doc2 texts match after applying all updates');
  }

  const totalElapsed = totalReceiveTime + totalApplyDuration;
  console.log(`>> Total apply time (ms): ${totalApplyDuration}`);
  console.log(`>> Combined receive+apply (ms): ${totalElapsed}`);
  const avgApplyTime = math.round(
    receiverMetrics.reduce((sum, m) => sum + m.applyTime, 0) / N
  );
  console.log(`>> Avg. per-update apply time (ms): ${avgApplyTime}`);

  // Write a CSV with metrics:
  {
    const header = ['id', 'sendingTimestamp', 'updateSize', 'applyTime'].join(',');
    const rows = [header];
    for (let i = 0; i < N; i++) {
      const s = senderMetrics[i];
      const r = receiverMetrics.find((r) => r.id === s.id) || {};
      rows.push([s.id, s.sendingTimestamp, s.size, r.applyTime ?? ''].join(','));
    }
    const csvContent = rows.join('\n');
    writeFileSync(new URL('../s1-signal-sequential.csv', import.meta.url), csvContent);
    console.log('[CSV] Wrote s1-signal-sequential.csv');
  }

  // Optionally re-run encode/parse benchmarks on doc1’s final state:
  let encodedState = null;
  benchmarkTime(crdtFactory.getName(), '[B1-Signal] (encode final state)', () => {
    encodedState = doc1.getEncodedState();
  });
  benchmarkTime(crdtFactory.getName(), '[B1-Signal] (load & parse)', () => {
    const startHeap = getMemUsed();
    const loadedDoc = crdtFactory.load(() => { }, encodedState);
    if (loadedDoc.getText() !== doc1.getText()) {
      throw new Error('Loaded document mismatch!');
    }
    logMemoryUsed(crdtFactory.getName(), '[B1-Signal] reload', startHeap);
  });

  setBenchmarkResult(
    crdtFactory.getName(),
    '[B1-Signal] receive+apply time',
    `${totalElapsed} ms`
  );
}
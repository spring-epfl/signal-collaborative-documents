import ProgressBar from 'progress';
import { randomUUID } from 'crypto';
import {
  setBenchmarkResult,
  benchmarkTime,
  runBenchmark,
  logMemoryUsed,
  getMemUsed
} from './utils.js';
import * as t from 'lib0/testing';
import { CrdtFactory, AbstractCrdt } from './index.js'; // eslint-disable-line
import { edits, finalText } from './b4-editing-trace.js';
import { writeFileSync } from 'fs';
import { deserializeMessage, serializeMessage } from './utils.js';
import { sendMessage } from './signal-api.js';
import { spawn } from 'child_process';

const groupId = 'wTNY8teX//CGUwj/7wXVQSqnJqVkxmWaessV0HPkSlI=';

const account1 = '+41782255248';
const account2 = '+41783227908';

let updateIdCounter = 0;
let updatesSize = 0;
const signalMetrics = new Map(); // id -> { envelopeTimestamp, receivingTimestamp }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Utility to serialize a CRDT update and send it to Signal (account1).
 * We keep track of total bytes sent in `updatesSize`.
 */
async function sendAndRecordUpdate(crdtDoc, editOp, senderAccount, runId) {
  // editOp = [pos, delLen, insText]
  const thisUpdateId = ++updateIdCounter;
  crdtDoc.transact(() => {
    const [pos, delLen, insText] = editOp;
    if (delLen > 0) crdtDoc.deleteText(pos, delLen);
    if (insText) crdtDoc.insertText(pos, insText);
  });

  if (!crdtDoc._lastUpdate) {
    throw new Error('No CRDT update was produced by this operation. Ensure the document was created with an onUpdate callback that stores the latest update (e.g., set crdt._lastUpdate in the create() callback), and that your editOp actually changes the document.');
  }

  // The factory’s “onUpdate” callback stores the raw bytes here:
  const updateBytes = crdtDoc._lastUpdate;
  const updateSize = updateBytes.length;
  updatesSize += updateSize;

  const serializedMsg = serializeMessage(thisUpdateId, updateBytes);
  const payload = JSON.stringify({ runId, id: thisUpdateId, b64: serializedMsg });

  await sendMessage(senderAccount, groupId, payload);

  return {
    id: thisUpdateId,
    size: updateSize
  };
}

export const runBenchmarkB1Signal = async (crdtFactory, filter) => {
  await runSequentialThenReceive(crdtFactory);
};

async function runSequentialThenReceive(crdtFactory) {
  // -------------------------
  // PHASE 1: User 1 (doc1)
  // -------------------------
  console.log(`[USER1:${account1}] create empty doc, replay real-world editing trace from b4-editing-trace.js`);
  const runId = randomUUID();
  const startTs = Date.now();

  const doc1 = crdtFactory.create((updateBytes) => {
    // Capture the most recent raw update so sendAndRecordUpdate can serialize it
    doc1._lastUpdate = updateBytes;
  });
  const initialEncodedState = doc1.getEncodedState();

  const M = Math.floor(edits.length / 100);

  // Send updates with limited parallelism (true worker pool)
  const CONCURRENCY = Number(process.env.SIGNAL_SEND_CONCURRENCY || 8);
  const senderMetrics = [];
  const bar = new ProgressBar('Sending [:bar] :current/:total (:percent) ~:etas remaining', { total: M, width: 40 });

  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= M) break;
      const op = edits[idx];
      const { id, size } = await sendAndRecordUpdate(doc1, op, account1, runId);
      senderMetrics.push({ id, size });
      bar.tick(1);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const totalSentBytes = senderMetrics.reduce((acc, cur) => acc + cur.size, 0);
  console.log(`[USER1:${account1}] Sent ${M} updates from B4 trace. Total bytes sent = ${totalSentBytes}`);

  // Phase 2: receive updates
  const doc2 = crdtFactory.load(() => { }, initialEncodedState);
  const startTimestamp = Date.now(); // client 2 "comes online"

  // Stream events by repeatedly long-polling receive with a short timeout and
  // parsing line-delimited JSON as it arrives. We apply updates immediately to
  // minimize end-to-end time, and we never concatenate the entire stdout.
  const receivedSoFar = new Map(); // id -> raw update Uint8Array
  let totalReceiveTime = 0;
  const receiverMetrics = [];

  // Fail-safe for polling so we don't loop forever when nothing matches our filter
  const MAX_IDLE_POLLS = 5;
  let idlePolls = 0;

  async function receiveAndProcessOnce(timeoutSeconds = 60) {
    const start = Date.now();
    return await new Promise((resolve) => {
      let gotAny = 0;
      // Keep a partial line buffer to handle chunk boundaries cleanly
      let buf = '';

      const child = spawn('signal-cli', [
        '--output', 'json',
        "--config=../../../signal-data/signal-multiaccount",
        '-u', account2,
        'receive',
        '--timeout', String(timeoutSeconds)
      ]);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      function handleLine(line) {
        const s = line.trim();
        if (!s) return;
        let ev;
        try {
          ev = JSON.parse(s);
        } catch {
          // Ignore stray non-JSON lines
          return;
        }
        const dm = ev?.envelope?.dataMessage;
        if (!dm) return;
        if (dm?.groupInfo?.groupId !== groupId) return;
        if (dm.timestamp < startTs) return; // ignore stale messages from earlier runs

        let raw;
        try {
          if (typeof dm.message === 'string') {
            try {
              const inner = JSON.parse(dm.message);
              if (inner?.runId !== runId) return; // ignore other runs
              if (typeof inner.b64 === 'string') {
                raw = Buffer.from(inner.b64, 'base64');
              } else if (typeof inner.data === 'string') {
                raw = Buffer.from(inner.data, 'base64');
              } else {
                return;
              }
            } catch {
              // Not JSON -> not our run; we only accept JSON-wrapped payloads to be safe
              return;
            }
          } else if (dm.message && typeof dm.message.data === 'string') {
            raw = Buffer.from(dm.message.data, 'base64');
          } else {
            return;
          }
        } catch {
          return;
        }

        const u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const { id, update } = deserializeMessage(u8);

        if (!receivedSoFar.has(id)) {
          receivedSoFar.set(id, update);
          signalMetrics.set(id, { envelopeTimestamp: dm.timestamp, receivingTimestamp: Date.now() });
          // Apply immediately and record timing for smoother profile and lower latency
          const applyStart = Date.now();
          doc2.applyUpdate(update);
          const applyTime = Date.now() - applyStart;
          receiverMetrics.push({ id, applyTime });
          gotAny++;
        }
      }

      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });

      // Flush any remaining partial line on close
      child.on('close', () => {
        if (buf.length > 0) handleLine(buf);
        totalReceiveTime += Date.now() - start;
        resolve(gotAny);
      });

      child.on('error', () => {
        // Treat errors like an empty poll and move on
        if (buf.length > 0) handleLine(buf);
        totalReceiveTime += Date.now() - start;
        resolve(0);
      });
    });
  }

  while (receivedSoFar.size < M) {
    const got = await receiveAndProcessOnce(60);
    if (got > 0) {
      idlePolls = 0;
      console.log(`\tCollected so far: ${receivedSoFar.size}/${M}`);
    } else {
      idlePolls++;
      if (idlePolls >= MAX_IDLE_POLLS) {
        console.log(`\tGiving up after ${MAX_IDLE_POLLS} idle polls with no new messages`);
        break;
      }
      await sleep(250); // small backoff; we want responsiveness
    }
  }

  console.log(`Collected ${receivedSoFar.size}/${M} updates (≈ ${totalReceiveTime} ms total receive time).\n`);

  // Updates were applied immediately as they were received; synthesize totals
  const totalApplyDuration = receiverMetrics.reduce((acc, m) => acc + (m.applyTime || 0), 0);

  // Verify final document equality:
  if (doc1.getText() !== doc2.getText()) {
    console.error('[ERROR] Final documents do not match!');
  } else {
    console.log('[SUCCESS] doc1 and doc2 texts match after applying all updates');
  }
  if (doc1.getText() !== finalText) {
    console.error('[ERROR] doc1 final text does not match B4 finalText reference!');
  }
  if (doc2.getText() !== finalText) {
    console.error('[ERROR] doc2 final text does not match B4 finalText reference!');
  }

  {
    const header = [
      'id',
      'startTimestamp',
      'updateSize',
      'envelopeTimestamp',
      'applyTime',
      'receivingTimestamp'
    ].join(',');
    const rows = [header];

    // Build quick lookup maps
    const senderMap = new Map(senderMetrics.map(m => [m.id, m]));
    const receiverMap = new Map(receiverMetrics.map(m => [m.id, m]));

    const allIds = new Set([
      ...senderMetrics.map(m => m.id),
      ...signalMetrics.keys(),
      ...receiverMetrics.map(m => m.id)
    ]);

    const sortedAllIds = Array.from(allIds).sort((a, b) => a - b);
    for (const id of sortedAllIds) {
      const sm = senderMap.get(id) || {};
      const sgn = signalMetrics.get(id) || {};
      const rm = receiverMap.get(id) || {};
      rows.push([
        id,
        startTimestamp,
        sm.size ?? '',
        sgn.envelopeTimestamp ?? '',
        rm.applyTime ?? '',
        sgn.receivingTimestamp ?? ''
      ].join(','));
    }

    console.log('\n' + rows.join('\n'));
    writeFileSync(new URL('../../benchmark_data/s1-signal.csv', import.meta.url), rows.join('\n'));
  }
}

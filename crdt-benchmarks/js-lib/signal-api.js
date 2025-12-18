// Helper to extract challenge/token from any nested error object or string
function extractChallengeToken(any) {
  // Only accept explicit challenge/captcha fields or a signalcaptcha:// URL in strings.
  const queue = [any];
  const seen = new Set();
  const captchaRe = /signalcaptcha:\/\/[^\s'"}]+/;

  while (queue.length) {
    const cur = queue.shift();
    if (cur == null || (typeof cur === 'object' && seen.has(cur))) continue;

    if (typeof cur === 'string') {
      const m = cur.match(captchaRe);
      if (m) return m[0];
      continue; // do NOT accept bare UUIDs; they may be recipientAddress.uuid
    }

    if (typeof cur === 'object') {
      seen.add(cur);
      // Prefer explicit/known keys
      const keys = Object.keys(cur);
      for (const k of keys) {
        const v = cur[k];
        const lk = k.toLowerCase();
        if (lk.includes('captcha') || lk.includes('challenge')) {
          if (typeof v === 'string') {
            // Could be either a UUID (server-provided challenge) or signalcaptcha:// token
            // Only return if it looks like a signalcaptcha token or is clearly labeled as a challenge
            const m = typeof v === 'string' ? v.match(captchaRe) : null;
            if (m) return m[0];
            // If key explicitly contains 'challenge', accept it verbatim
            if (lk.includes('challenge')) return v;
          } else if (v && typeof v === 'object') {
            // Nested object likely like { challenge: '...', options: [...] }
            if (typeof v.challenge === 'string') return v.challenge;
            if (typeof v.captcha === 'string') {
              const m2 = v.captcha.match(captchaRe);
              if (m2) return m2[0];
            }
          }
        }
      }
      // breadth-first search through nested values
      for (const k of keys) queue.push(cur[k]);
    }
  }
  return undefined;
}

import http from 'http';
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

async function rpc(method, params) {
  // If a single object is passed, treat it as named parameters
  const rpcParams =
    Array.isArray(params) &&
      params.length === 1 &&
      typeof params[0] === 'object' &&
      !Array.isArray(params[0])
      ? params[0]
      : params;

  const res = await fetch('http://localhost:8080/api/v1/rpc', {
    method: 'POST',
    agent: agent,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: rpcParams,
      id: Date.now()
    })
  });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message || 'JSON-RPC error');
    // Preserve structured details for callers
    err.code = json.error.code;
    err.data = json.error.data; // often contains { challenge, options, wait, retryAfter }
    err.raw = json.error;
    throw err;
  }
  return json.result;
}

const api = new Proxy({}, {
  get(_, method) {
    return (...params) => rpc(method, params);
  }
});

export async function sendMessage(account, groupId, message) {
  try {
    await api.send({
      account: account,
      groupId: groupId,
      message: message
    });
  } catch (e) {
    // Surface rate-limit details from the JSON-RPC error
    const d = e && (e.data || e.raw || {});
    let challenge = d.challenge || d.token;
    if (!challenge) {
      // Try to dig it out of any nested fields or messages
      challenge = extractChallengeToken(e) || extractChallengeToken(d) || extractChallengeToken(e?.message);
    }
    const options = d.options || d.availableOptions;
    const wait = d.wait ?? d.retryAfter;

    console.error('[signal rate-limit]',
      `code=${e.code ?? 'n/a'}`,
      challenge ? `challenge=${challenge}` : 'challenge=n/a',
      options ? `options='${Array.isArray(options) ? options.join(',') : String(options)}'` : 'options=n/a',
      (wait !== undefined) ? `wait=${wait}` : 'wait=n/a'
    );

    // Wrap and rethrow the error with extra details
    const wrapped = new Error(e.message);
    wrapped.code = e.code;
    wrapped.data = e.data;
    wrapped.raw = e.raw || e;
    if (challenge) wrapped.challenge = challenge;
    if (options) wrapped.options = options;
    if (wait !== undefined) wrapped.wait = wait;
    throw wrapped;
  }
}

/**
 * fetchGroupMessages(account, groupId):
 *   1. Calls `jsonRpc('receive', { account, waitForIncomingMessages: false })`.
 *   2. Filters the returned array for any messages whose `envelope.groupInfo.groupId` matches.
 *   3. Returns a list of { envelope: { dataMessage: { timestamp, message: <Uint8Array> } } }.
 *
 * The exact shape of `jsonRpc('receive')` → result array looks like:
 *   [
 *     {
 *       envelope: {
 *         type: 'incomingMessage',
 *         source: '+41782255248',
 *         sourceDevice: 1,
 *         timestamp: 1620000000000,
 *         dataMessage: {
 *           groupInfo: { groupId: 'wTNY8teX…', type: 'update' },
 *           message: {
 *             data: 'BASE64ENCODED_CRDT_BYTES',
 *             // …there may be attachments, but we only care about raw bytes
 *           }
 *         }
 *       }
 *     },
 *     { … }, …
 *   ]
 */
export async function fetchGroupMessages(account, groupId) {
  // Attempt to receive up to 1000 messages, returning immediately if none are queued.
  const inbound = await api.receive({
    account: account,
    maxMessages: 1000,
    timeout: 0
  });

  // Filter out only the group messages for our groupId
  const out = [];
  for (const ev of inbound) {
    if (
      ev.envelope &&
      ev.envelope.dataMessage &&
      ev.envelope.dataMessage.groupInfo &&
      ev.envelope.dataMessage.groupInfo.groupId === groupId &&
      ev.envelope.dataMessage.message &&
      ev.envelope.dataMessage.message.data
    ) {
      // Base64-decode the payload into a Buffer/Uint8Array
      const rawBytes = Buffer.from(ev.envelope.dataMessage.message.data, 'base64');
      out.push({
        envelope: {
          dataMessage: {
            timestamp: ev.envelope.dataMessage.timestamp,
            message: rawBytes,
          },
        },
      });
    }
  }

  return out;
}
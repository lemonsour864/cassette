'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const https = require('node:https');
const { spawn } = require('node:child_process');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = jwt.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields, timeout = 30000) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  return { status: response.status, body };
}

function field(result, snake) {
  return result.body[snake] || result.body[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function responseHeaderHex(response, name) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === name.toLowerCase()) {
      values.push(Buffer.from(response.rawHeaders[i + 1], 'latin1').toString('hex'));
    }
  }
  return values;
}

function request(target, options = {}) {
  return new Promise((resolve) => {
    const req = https.request(target, { method: options.method || 'GET',
      headers: options.headers || {}, timeout: 30000, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const xml = /<Code>([^<]{1,80})<\/Code>/.exec(body.toString('utf8'));
        resolve({ status: response.statusCode,
          contentTypeHex: responseHeaderHex(response, 'content-type'),
          errorCode: response.headers['x-ms-error-code'] || (xml && xml[1]) || '',
          length: body.length,
          sha: response.statusCode < 400 ? crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) : '',
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ error: `${error.code || error.name}:${error.message}` }));
    req.end(options.body);
  });
}

async function create(ctx, label) {
  const name = `azurect-tunnel-${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
  const made = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: 'application/json' });
  return { name, made, upload: field(made, 'signed_upload_url') };
}

async function finalize(ctx, item, body) {
  const result = await rpc(ctx, 'FinalizeArtifact', { name: item.name,
    size: String(body.length), hash: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}` }, 60000);
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name: item.name });
  return { finalize: result.status, signed: signed.status, download: field(signed, 'signed_url') };
}

function startOrigin(body) {
  const types = new Map([
    ['/safe', Buffer.from('application/json', 'ascii')],
    ['/raw85', Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')])],
    ['/raw1f', Buffer.concat([Buffer.from([0x1f]), Buffer.from('application/json')])],
    ['/utf8nel', Buffer.concat([Buffer.from([0xc2, 0x85]), Buffer.from('application/json')])],
    ['/utf8u0185', Buffer.concat([Buffer.from([0xc6, 0x85]), Buffer.from('application/json')])],
  ]);
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (!input.includes(Buffer.from('\r\n\r\n'))) return;
      const line = input.toString('latin1').split('\r\n', 1)[0] || '';
      const path = line.split(' ')[1] || '/safe';
      const type = types.get(path) || types.get('/safe');
      const head = Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: `, 'ascii'),
        type,
        Buffer.from('\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n', 'ascii'),
      ]);
      socket.end(Buffer.concat([head, body]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cloudflared(port) {
  const binary = '/tmp/cloudflared-azurect';
  if (!fs.existsSync(binary)) {
    const response = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`cloudflared download ${response.status}`);
    fs.writeFileSync(binary, Buffer.from(await response.arrayBuffer()));
    fs.chmodSync(binary, 0o755);
  }
  const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate',
    '--loglevel', 'info'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('tunnel URL timeout')); }, 60000);
    const receive = (chunk) => {
      logs += chunk.toString('utf8');
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(logs);
      if (match) { clearTimeout(timer); resolve({ child, base: match[0] }); }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!/trycloudflare\.com/.test(logs)) { clearTimeout(timer); reject(new Error(`tunnel exited ${code}`)); }
    });
  });
}

async function uploadFromExternal(ctx, label, source, body, copyProperties) {
  const item = await create(ctx, label);
  const output = { label, create: item.made.status, uploadPermission: item.upload ? new URL(item.upload).searchParams.get('sp') : null };
  if (!item.upload) return output;
  output.putFromUrl = await request(item.upload, { method: 'PUT', headers: {
    'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': source,
    'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': copyProperties ? 'true' : 'false',
  }});
  if (output.putFromUrl.status === 201) {
    const done = await finalize(ctx, item, body);
    output.finalize = done.finalize;
    output.signed = done.signed;
    if (done.download) {
      output.normal = await request(done.download);
      output.storedOldHeader = await request(done.download, { headers: { 'x-ms-version': '2009-09-19' } });
      output.storedOldQuery = await request(done.download + '&api-version=2009-09-19');
    }
  }
  return output;
}

(async () => {
  const ctx = context();
  const body = Buffer.from('{"source":"raw-http-origin","ok":true}');
  const origin = await startOrigin(body);
  const tunnel = await cloudflared(origin.port);
  console.log('TUNNEL ' + JSON.stringify({ ready: true, provider: 'trycloudflare' }));
  try {
    let readiness = null;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      readiness = await request(tunnel.base + '/safe');
      if (readiness.status === 200) break;
      await pause(2000);
    }
    console.log('READY_CHECK ' + JSON.stringify(readiness));
    for (const path of ['/safe', '/raw85', '/raw1f', '/utf8nel', '/utf8u0185']) {
      const source = tunnel.base + path;
      const observed = await request(source);
      console.log('ORIGIN ' + JSON.stringify({ path, observed }));
      for (const copyProperties of [true, false]) {
        const label = path.slice(1) + (copyProperties ? '-props' : '-noprops');
        console.log('EXTERNAL ' + JSON.stringify(await uploadFromExternal(ctx, label, source, body, copyProperties)));
      }
    }
  } finally {
    tunnel.child.kill('SIGTERM');
    origin.server.close();
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

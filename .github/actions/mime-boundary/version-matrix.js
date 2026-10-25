'use strict';

const crypto = require('node:crypto');
const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields, timeout = 20000) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

function url(result, field) {
  return result.body[field] || result.body[field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function compact(result) {
  return { status: result.status, ok: result.body.ok,
    id: result.body.artifact_id || result.body.artifactId || null,
    message: result.body.msg || result.body.message || result.body.code || result.body.raw || '' };
}

async function get(target, old) {
  if (!target) return null;
  const response = await fetch(target, {
    headers: old ? { 'x-ms-version': '2009-09-19' } : {},
    signal: AbortSignal.timeout(20000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status,
    contentTypeHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
    length: body.length,
    sha: crypto.createHash('sha256').update(body).digest('hex') };
}

async function one(ctx, version, variant, mime) {
  const name = `version-${version}-${variant}-${Date.now()}.json`;
  const payload = Buffer.from(JSON.stringify({ full_name: `version/${version}`,
    owner: { login: 'version', avatar_url: 'file:///proc/self/environ' }, variant }));
  const fields = { name, version };
  if (mime !== undefined) fields.mime_type = mime;
  const created = await rpc(ctx, 'CreateArtifact', fields);
  const uploadUrl = url(created, 'signed_upload_url');
  const output = { version, variant, create: compact(created), hasUpload: Boolean(uploadUrl) };
  if (!uploadUrl) return output;
  const nel = String.fromCharCode(0x85) + 'application/json';
  try {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream',
        'x-ms-blob-content-type': nel, 'x-ms-blob-type': 'BlockBlob' },
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
    output.upload = put.status;
  } catch (error) {
    output.uploadError = `${error.name}:${error.message}`;
    return output;
  }
  const finalized = await rpc(ctx, 'FinalizeArtifact', {
    name,
    size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  }, 60000);
  output.finalize = compact(finalized);
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const downloadUrl = url(signed, 'signed_url');
  output.signed = compact(signed);
  output.rsct = downloadUrl ? new URL(downloadUrl).searchParams.get('rsct') : null;
  output.direct = await get(downloadUrl, false);
  output.old = await get(downloadUrl, true);
  return output;
}

(async () => {
  const ctx = context();
  const variants = [
    ['absent', undefined],
    ['json', 'application/json'],
    ['nel', String.fromCharCode(0x85) + 'application/json'],
  ];
  for (let version = 0; version <= 7; version += 1) {
    for (const [variant, mime] of variants) {
      try { console.log('VERSION ' + JSON.stringify(await one(ctx, version, variant, mime))); }
      catch (error) { console.log('VERSION ' + JSON.stringify({ version, variant,
        error: `${error.name}:${error.message}` })); }
    }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

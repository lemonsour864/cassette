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

async function rpc(ctx, method, body, timeout = 20000) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed };
}

function summarize(result) {
  return {
    status: result.status,
    ok: result.body.ok,
    artifactId: result.body.artifact_id || result.body.artifactId || null,
    message: result.body.msg || result.body.message || result.body.code || result.body.raw || '',
  };
}

function urlFrom(result, kind) {
  return result.body[kind] || result.body[kind.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function blobKey(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.hostname + parsed.pathname;
}

function headerHex(response, name) {
  return Buffer.from(response.headers.get(name) || '', 'latin1').toString('hex');
}

async function upload(url, body, property) {
  if (!url) return { status: null };
  const headers = { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' };
  if (property !== undefined) headers['x-ms-blob-content-type'] = property;
  const response = await fetch(url, { method: 'PUT', headers, body,
    signal: AbortSignal.timeout(20000) });
  return { status: response.status, contentTypeHex: headerHex(response, 'content-type') };
}

async function inspect(url) {
  if (!url) return { status: null };
  const response = await fetch(url, { headers: { 'x-ms-version': '2009-09-19' },
    signal: AbortSignal.timeout(20000) });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentTypeHex: headerHex(response, 'content-type'),
    bodyLength: body.length,
    bodySha: crypto.createHash('sha256').update(body).digest('hex'),
    body: body.toString('utf8').slice(0, 140),
  };
}

async function standalone(ctx, index, label, property) {
  const name = `migrate-${index}-${Date.now()}.json`;
  const body = Buffer.from(JSON.stringify({ full_name: 'migrate/probe',
    owner: { login: 'migrate', avatar_url: 'file:///proc/self/environ' }, marker: label }));
  const migrated = await rpc(ctx, 'MigrateArtifact', {
    workflow_run_backend_id: ctx.runId,
    name,
  });
  const uploadUrl = urlFrom(migrated, 'signed_upload_url');
  const output = { label, name, migrate: summarize(migrated), hasUpload: Boolean(uploadUrl) };
  if (uploadUrl) {
    output.upload = await upload(uploadUrl, body, property);
    output.direct = await inspect(uploadUrl);
    const before = await rpc(ctx, 'GetSignedArtifactURL', {
      workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId,
      name,
    });
    const beforeUrl = urlFrom(before, 'signed_url');
    output.signedBefore = summarize(before);
    output.signedBeforeTarget = blobKey(beforeUrl) === blobKey(uploadUrl) ? 'migrate' :
      beforeUrl ? 'other' : null;
    if (beforeUrl) output.downloadBefore = await inspect(beforeUrl);
    const finalized = await rpc(ctx, 'FinalizeMigratedArtifact', {
      workflow_run_backend_id: ctx.runId,
      name,
      size: String(body.length),
    }, 60000);
    output.finalizeMigrated = summarize(finalized);
    const after = await rpc(ctx, 'GetSignedArtifactURL', {
      workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId,
      name,
    });
    const afterUrl = urlFrom(after, 'signed_url');
    output.signedAfter = summarize(after);
    output.signedAfterTarget = blobKey(afterUrl) === blobKey(uploadUrl) ? 'migrate' :
      afterUrl ? 'other' : null;
    if (afterUrl) output.downloadAfter = await inspect(afterUrl);
  }
  console.log('MIGRATE ' + JSON.stringify(output));
}

(async () => {
  const ctx = context();
  const nel = String.fromCharCode(0x85) + 'application/json';
  const cases = [
    ['ordinary', undefined],
    ['nel-property', nel],
    ['json-property', 'application/json'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    try { await standalone(ctx, index, cases[index][0], cases[index][1]); }
    catch (error) {
      console.log('MIGRATE ' + JSON.stringify({ label: cases[index][0],
        error: `${error.name}:${error.message}` }));
    }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

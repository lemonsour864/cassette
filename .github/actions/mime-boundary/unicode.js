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

function headerHex(response, name) {
  return Buffer.from(response.headers.get(name) || '', 'latin1').toString('hex');
}

const codepoints = [
  0x0185, 0x0285, 0x0485, 0x0585, 0x0685, 0x0785, 0x0885,
  0x0985, 0x0a85, 0x0b85, 0x0c85, 0x0d85, 0x1085, 0x1185,
  0x1285, 0x1685, 0x1c85, 0x1d85, 0x1e85, 0x1f85, 0x2c85,
  0xa685, 0xa785, 0xab85, 0xff85, 0x10085, 0x10185, 0x10385,
  0x10485, 0x10585, 0x10a85, 0x10b85, 0x10c85, 0x10d85,
];

const cases = [
  ['baseline-json', 'application/json'],
  ['generic-token', 'a/b'],
  ['generic-x-json', 'application/x-json'],
  ['unicode-token', 'application/\u00e9'],
  ['fullwidth-slash', 'application\uff0fjson'],
];
for (const cp of codepoints) {
  const char = String.fromCodePoint(cp);
  cases.push([`u${cp.toString(16)}-prefix`, char + 'application/json']);
  cases.push([`u${cp.toString(16)}-subtype`, 'application/' + char + 'json']);
  cases.push([`u${cp.toString(16)}-suffix`, 'application/json' + char]);
}

(async () => {
  const ctx = context();
  const payload = Buffer.from('{"full_name":"unicode/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');
  const summary = [];
  for (let index = 0; index < cases.length; index += 1) {
    const [label, mimeType] = cases[index];
    const name = `unicode-${index}-${Date.now()}.json`;
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mimeType });
    const uploadUrl = created.body.signed_upload_url || created.body.signedUploadUrl;
    const item = {
      label,
      codepoints: Array.from(mimeType, (char) => char.codePointAt(0).toString(16)).join(','),
      create: created.status,
      accepted: Boolean(uploadUrl),
      message: created.body.msg || created.body.message || created.body.code || '',
    };
    if (uploadUrl) {
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
      const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
      const downloadUrl = signed.body.signed_url || signed.body.signedUrl;
      item.upload = uploaded.status;
      item.finalize = finalized.status;
      item.artifactId = finalized.body.artifact_id || finalized.body.artifactId || null;
      item.signed = signed.status;
      item.rsct = downloadUrl ? new URL(downloadUrl).searchParams.get('rsct') : null;
      if (downloadUrl) {
        const response = await fetch(downloadUrl, { redirect: 'follow' });
        item.get = response.status;
        item.contentTypeHex = headerHex(response, 'content-type');
      }
    }
    summary.push(item);
    console.log('CASE ' + JSON.stringify(item));
  }
  console.log('SUMMARY ' + JSON.stringify({
    total: summary.length,
    accepted: summary.filter((item) => item.accepted).map((item) => item.label),
  }));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

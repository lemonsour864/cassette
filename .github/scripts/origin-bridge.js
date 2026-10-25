'use strict';

const crypto = require('node:crypto');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function idsFromToken(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((item) => item.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return {runId, jobId};
}

function cleanBase(value, originOnly) {
  if (!value) return null;
  const parsed = new URL(value);
  if (originOnly) return parsed.origin;
  return value.replace(/\/+$/, '');
}

async function post(url, token, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    let decoded = {};
    try { decoded = JSON.parse(text); } catch {}
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      locationHost: response.headers.get('location') ? new URL(response.headers.get('location'), url).host : null,
      decoded,
    };
  } catch (error) {
    return {status: 0, error: String(error && error.name || error), decoded: {}};
  }
}

function summarize(label, base, method, result) {
  const signed = result.decoded.signed_url || result.decoded.signedUrl || null;
  let signedShape = null;
  if (signed) {
    const parsed = new URL(signed);
    signedShape = {
      host: parsed.host,
      queryKeys: [...new Set([...parsed.searchParams.keys()])].sort(),
      rsctHex: Buffer.from(parsed.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      hasApiVersion: parsed.searchParams.has('api-version'),
    };
  }
  console.log(JSON.stringify({
    label,
    baseHost: new URL(base).host,
    baseHasPathPrefix: new URL(base).pathname !== '/',
    method,
    status: result.status,
    type: result.type,
    locationHost: result.locationHost,
    bodyKeys: Object.keys(result.decoded).sort(),
    signedShape,
  }));
}

(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const ids = idsFromToken(token);
  const resultsOrigin = cleanBase(process.env.ACTIONS_RESULTS_URL, true);
  const runtimeOrigin = cleanBase(process.env.ACTIONS_RUNTIME_URL, true);
  const runtimeFull = cleanBase(process.env.ACTIONS_RUNTIME_URL, false);
  const cacheOrigin = cleanBase(process.env.ACTIONS_CACHE_URL, true);

  console.log(JSON.stringify({kind: 'hosts', results: new URL(resultsOrigin).host,
    runtime: runtimeOrigin && new URL(runtimeOrigin).host,
    cache: cacheOrigin && new URL(cacheOrigin).host,
    runtimeHasPrefix: runtimeFull && new URL(runtimeFull).pathname !== '/'}));

  const name = `origin-bridge-${Date.now()}.json`;
  const payload = Buffer.from(JSON.stringify({
    full_name: 'bridge/body',
    owner: {login: 'bridge', avatar_url: 'file:///proc/self/environ'},
  }));
  const createBody = {
    workflow_run_backend_id: ids.runId,
    workflow_job_run_backend_id: ids.jobId,
    name,
    mime_type: 'application/json',
    version: 7,
  };
  const created = await post(resultsOrigin + SERVICE + 'CreateArtifact', token, createBody);
  summarize('baseline-create', resultsOrigin, 'CreateArtifact', created);
  const upload = created.decoded.signed_upload_url || created.decoded.signedUploadUrl;
  if (!upload) process.exit(2);
  const put = await fetch(upload, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob'},
    body: payload,
    signal: AbortSignal.timeout(20000),
  });
  console.log(JSON.stringify({kind: 'upload', status: put.status}));
  const finalized = await post(resultsOrigin + SERVICE + 'FinalizeArtifact', token, {
    workflow_run_backend_id: ids.runId,
    workflow_job_run_backend_id: ids.jobId,
    name,
    size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  });
  summarize('baseline-finalize', resultsOrigin, 'FinalizeArtifact', finalized);

  const signedBody = {
    workflow_run_backend_id: ids.runId,
    workflow_job_run_backend_id: ids.jobId,
    name,
  };
  const bases = [];
  function add(label, base) {
    if (!base || bases.some((item) => item.base === base)) return;
    bases.push({label, base});
  }
  add('results-origin', resultsOrigin);
  add('runtime-origin', runtimeOrigin);
  add('runtime-prefix', runtimeFull);
  add('cache-origin', cacheOrigin);
  add('generic-results', 'https://results.actions.githubusercontent.com');
  add('generic-pipelines', 'https://pipelines.actions.githubusercontent.com');

  for (const candidate of bases) {
    const result = await post(candidate.base + SERVICE + 'GetSignedArtifactURL', token, signedBody);
    summarize(candidate.label, candidate.base, 'GetSignedArtifactURL', result);
  }

  const legacyUrl = runtimeFull + `/_apis/pipelines/workflows/${encodeURIComponent(ids.runId)}/artifacts?api-version=6.0-preview`;
  const legacy = await post(legacyUrl, token, {Type: 'actions_storage', Name: `legacy-${Date.now()}`});
  summarize('runtime-prefix-legacy', runtimeFull, 'LegacyCreate', legacy);
})().catch((error) => {
  console.log(JSON.stringify({kind: 'fatal', name: error && error.name, message: error && error.message}));
  process.exit(1);
});

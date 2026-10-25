'use strict';

const crypto = require('node:crypto');

const CREATE = '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact';
const FINALIZE = '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact';

function idsFromToken(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { runId, jobId };
}

function query(url, extra) {
  const result = new URL(url);
  for (const [name, value] of Object.entries(extra)) result.searchParams.set(name, value);
  return result;
}

function headerHex(response, name) {
  const value = response.headers.get(name) || '';
  return Buffer.from(value, 'latin1').toString('hex');
}

async function post(base, path, token, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function create(base, token, ids, name, mimeType, version = 7) {
  const body = {
    workflow_run_backend_id: ids.runId,
    workflow_job_run_backend_id: ids.jobId,
    name,
    version,
    mime_type: mimeType,
  };
  return post(base, CREATE, token, body);
}

async function finalize(base, token, ids, name, payload) {
  return post(base, FINALIZE, token, {
    workflow_run_backend_id: ids.runId,
    workflow_job_run_backend_id: ids.jobId,
    name,
    size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  });
}

async function uploadAndInspect(url, payload, headers) {
  const put = await fetch(url, { method: 'PUT', headers, body: payload });
  const get = await fetch(url, { headers: { 'x-ms-version': '2009-09-19' } });
  return {
    put: put.status,
    get: get.status,
    contentTypeHex: headerHex(get, 'content-type'),
    bodyMatches: Buffer.compare(Buffer.from(await get.arrayBuffer()), payload) === 0,
  };
}

(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const ids = idsFromToken(token);
  const payload = Buffer.from('{"full_name":"percent/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');

  const mimeCases = [
    '%85application/json',
    '%C2%85application/json',
    '%c2%85application/json',
    '%1Fapplication/json',
    'application/json%85',
    'application/json%C2%85',
    'application/%6ason',
    'application%2fjson',
    'application/json&x=x',
    '#application/json',
  ];
  for (let index = 0; index < mimeCases.length; index += 1) {
    const mime = mimeCases[index];
    const name = `pct-${index}-${Date.now()}.json`;
    const made = await create(base, token, ids, name, mime);
    const uploadUrl = made.body.signedUploadUrl || made.body.signed_upload_url;
    if (!uploadUrl) {
      console.log(JSON.stringify({ kind: 'mime', index, mime, create: made.status, accepted: false }));
      continue;
    }
    const check = await uploadAndInspect(uploadUrl, payload, {
      'Content-Type': 'application/octet-stream',
      'x-ms-blob-type': 'BlockBlob',
    });
    const done = await finalize(base, token, ids, name, payload);
    console.log(JSON.stringify({ kind: 'mime', index, mime, create: made.status, accepted: true,
      artifactId: done.body.artifact_id || done.body.artifactId || null, finalize: done.status, ...check }));
  }

  const nel = String.fromCharCode(0x85) + 'application/json';
  const propertyCases = [
    { label: 'xms-only', headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-content-type': nel } },
    { label: 'both-nel', headers: { 'Content-Type': nel, 'x-ms-blob-content-type': nel } },
    { label: 'xms-old', headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-content-type': nel,
      'x-ms-version': '2009-09-19' } },
    { label: 'trailing-content-type', headers: { 'Content-Type': 'application/json' + String.fromCharCode(0x85) } },
    { label: 'trailing-xms', headers: { 'Content-Type': 'application/octet-stream',
      'x-ms-blob-content-type': 'application/json' + String.fromCharCode(0x85) } },
  ];
  for (let index = 0; index < propertyCases.length; index += 1) {
    const test = propertyCases[index];
    const name = `property-${index}-${Date.now()}.json`;
    const made = await create(base, token, ids, name, 'application/json');
    const uploadUrl = made.body.signedUploadUrl || made.body.signed_upload_url;
    if (!uploadUrl) {
      console.log(JSON.stringify({ kind: 'property', label: test.label, create: made.status, accepted: false }));
      continue;
    }
    let check;
    try {
      check = await uploadAndInspect(uploadUrl, payload, { 'x-ms-blob-type': 'BlockBlob', ...test.headers });
    } catch (error) {
      check = { error: String(error && error.message || error) };
    }
    const done = await finalize(base, token, ids, name, payload);
    console.log(JSON.stringify({ kind: 'property', label: test.label, create: made.status,
      artifactId: done.body.artifact_id || done.body.artifactId || null, finalize: done.status, ...check }));
  }

  const name = `set-property-${Date.now()}.json`;
  const made = await create(base, token, ids, name, 'application/json');
  const uploadUrl = made.body.signedUploadUrl || made.body.signed_upload_url;
  if (uploadUrl) {
    const first = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
      body: payload,
    });
    let property;
    try {
      property = await fetch(query(uploadUrl, { comp: 'properties' }), {
        method: 'PUT',
        headers: { 'x-ms-blob-content-type': nel, 'x-ms-version': '2009-09-19' },
      });
    } catch (error) {
      property = { status: `error:${error.message}` };
    }
    const get = await fetch(uploadUrl, { headers: { 'x-ms-version': '2009-09-19' } });
    const done = await finalize(base, token, ids, name, payload);
    console.log(JSON.stringify({ kind: 'set-property', first: first.status, property: property.status,
      get: get.status, contentTypeHex: headerHex(get, 'content-type'),
      artifactId: done.body.artifact_id || done.body.artifactId || null, finalize: done.status }));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

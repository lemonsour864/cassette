'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function runtimeContext() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields, ids = {}) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow_run_backend_id: ids.runId || ctx.runId,
      workflow_job_run_backend_id: ids.jobId || ctx.jobId,
      ...fields,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

const uploadUrl = r => r.body.signed_upload_url || r.body.signedUploadUrl || null;
const downloadUrl = r => r.body.signed_url || r.body.signedUrl || null;
const artifactId = r => r.body.artifact_id || r.body.artifactId || null;

function signedSummary(r) {
  const url = downloadUrl(r);
  if (!url) return { status: r.status, message: r.body.msg || r.body.message || r.body.code || r.body.raw || '' };
  const u = new URL(url);
  const rsct = u.searchParams.get('rsct') || '';
  return {
    status: r.status,
    blob: sha(u.hostname + u.pathname).slice(0, 20),
    rsct: Array.from(rsct, c => c.codePointAt(0).toString(16)).join(','),
  };
}

async function getSummary(r) {
  const result = signedSummary(r);
  const url = downloadUrl(r);
  if (!url) return result;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      ...result,
      get: response.status,
      contentType: response.headers.get('content-type') || '',
      length: body.length,
      sha: sha(body),
      marker: body.toString('utf8').slice(0, 180),
    };
  } catch (error) {
    return { ...result, getError: `${error.name}:${error.message}` };
  }
}

async function put(url, body) {
  if (!url) return null;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  return response.status;
}

async function waitUntil(epochMs) {
  const remaining = epochMs - Date.now();
  if (remaining > 0) await pause(remaining);
}

function cases(runId) {
  const p = `xj-${runId}`;
  return [
    { label: 'exact', legacy: `${p}-exact.json`, raw: `${p}-exact.json` },
    { label: 'ascii-case', legacy: `${p}-Case.json`, raw: `${p}-case.json` },
    { label: 'unicode-nfc', legacy: `${p}-caf\u00e9.json`, raw: `${p}-cafe\u0301.json` },
    { label: 'trailing-dot', legacy: `${p}-trail.json`, raw: `${p}-trail.json.` },
    { label: 'trailing-space', legacy: `${p}-space.json`, raw: `${p}-space.json ` },
    { label: 'fullwidth', legacy: `${p}-\uff21.json`, raw: `${p}-A.json` },
    { label: 'kelvin', legacy: `${p}-\u212a.json`, raw: `${p}-K.json` },
  ];
}

async function producer(ctx, role) {
  const target = Number(process.env.INPUT_TARGET) * 1000;
  const all = cases(ctx.runId);
  const state = { role, runId: ctx.runId, jobId: ctx.jobId, cases: [] };
  console.log('CTX ' + JSON.stringify({ role, runId: ctx.runId, jobId: ctx.jobId,
    target, now: Date.now(), wait: target - Date.now() }));
  for (let index = 0; index < all.length; index += 1) {
    const c = all[index];
    const name = c[role];
    const peerName = c[role === 'legacy' ? 'raw' : 'legacy'];
    const slot = target + index * 6500;
    await waitUntil(slot);
    const version = role === 'legacy' ? 6 : 7;
    const mime = role === 'legacy' ? '\u0185application/json' : 'application/json';
    const marker = JSON.stringify({ probe: 'cross-job', role, case: c.label,
      run: ctx.runId, name, nonce: `${role}-${index}-body` });
    const body = Buffer.from(marker);
    const created = await rpc(ctx, 'CreateArtifact', { name, version, mime_type: mime });
    const up = uploadUrl(created);
    const upParsed = up && new URL(up);
    const row = {
      label: c.label, name, peerName, create: created.status,
      createMessage: created.body.msg || created.body.message || created.body.code || '',
      uploadBlob: upParsed ? sha(upParsed.hostname + upParsed.pathname).slice(0, 20) : null,
      bodySha: sha(body),
    };
    row.put = await put(up, body);
    await waitUntil(slot + 2300);
    const finalized = await rpc(ctx, 'FinalizeArtifact', {
      name,
      size: String(body.length),
      hash: `sha256:${sha(body)}`,
    });
    row.finalize = finalized.status;
    row.artifactId = artifactId(finalized);
    row.finalizeMessage = finalized.body.msg || finalized.body.message || finalized.body.code || '';
    await waitUntil(slot + 4000);
    row.signedOwn = await getSummary(await rpc(ctx, 'GetSignedArtifactURL', { name }));
    row.signedPeerSpelling = name === peerName ? null :
      await getSummary(await rpc(ctx, 'GetSignedArtifactURL', { name: peerName }));
    state.cases.push(row);
    console.log('PRODUCER ' + JSON.stringify({ role, ...row }));
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=${JSON.stringify(state)}\n`);
}

async function listArtifacts(ctx, ids, name) {
  const r = await rpc(ctx, 'ListArtifacts', { name_filter: name }, ids);
  const artifacts = Array.isArray(r.body.artifacts) ? r.body.artifacts : [];
  return {
    status: r.status,
    message: r.body.msg || r.body.message || r.body.code || r.body.raw || '',
    artifacts: artifacts.map(a => ({
      name: a.name,
      id: a.database_id || a.databaseId || null,
      jobId: a.workflow_job_run_backend_id || a.workflowJobRunBackendId || null,
      size: a.size,
    })),
  };
}

async function restArtifacts() {
  const H = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const root = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  let response, json;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${root}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`,
      { headers: H, signal: AbortSignal.timeout(15000) });
    json = await response.json().catch(() => ({}));
    const found = (json.artifacts || []).filter(a => a.name.startsWith('xj-'));
    if (found.length >= 7 || attempt === 5) break;
    await pause(5000);
  }
  const output = { status: response.status, total: json.total_count,
    artifacts: [] };
  for (const a of (json.artifacts || []).filter(a => a.name.startsWith('xj-'))) {
    const dl = await fetch(`${root}/actions/artifacts/${a.id}/zip`, {
      headers: H, redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    const loc = dl.headers.get('location');
    const item = { id: String(a.id), name: a.name, size: a.size_in_bytes,
      redirect: dl.status };
    if (loc) {
      const u = new URL(loc);
      item.blob = sha(u.hostname + u.pathname).slice(0, 20);
      item.rsct = Array.from(u.searchParams.get('rsct') || '',
        c => c.codePointAt(0).toString(16)).join(',');
      try {
        const got = await fetch(loc, { signal: AbortSignal.timeout(15000) });
        const body = Buffer.from(await got.arrayBuffer());
        item.get = got.status;
        item.contentType = got.headers.get('content-type') || '';
        item.length = body.length;
        item.sha = sha(body);
        item.marker = body.toString('utf8').slice(0, 180);
      } catch (error) { item.getError = `${error.name}:${error.message}`; }
    } else {
      item.message = (await dl.text()).slice(0, 200);
    }
    output.artifacts.push(item);
  }
  return output;
}

async function inspector(ctx) {
  const states = [JSON.parse(process.env.LEGACY_STATE), JSON.parse(process.env.RAW_STATE)];
  for (const state of states) {
    const ids = { runId: state.runId, jobId: state.jobId };
    for (const c of state.cases) {
      const own = await getSummary(await rpc(ctx, 'GetSignedArtifactURL', { name: c.name }, ids));
      const peer = c.name === c.peerName ? null :
        await getSummary(await rpc(ctx, 'GetSignedArtifactURL', { name: c.peerName }, ids));
      const ownList = await listArtifacts(ctx, ids, c.name);
      const peerList = c.name === c.peerName ? null : await listArtifacts(ctx, ids, c.peerName);
      console.log('CROSSQUERY ' + JSON.stringify({ inspectorJob: ctx.jobId,
        targetRole: state.role, targetJob: state.jobId, label: c.label,
        expectedUploadBlob: c.uploadBlob, expectedBodySha: c.bodySha,
        ownName: c.name, peerName: c.peerName, own, peer, ownList, peerList }));
    }
  }
  console.log('REST ' + JSON.stringify(await restArtifacts()));
}

(async () => {
  const ctx = runtimeContext();
  const role = process.env.INPUT_ROLE;
  if (role === 'legacy' || role === 'raw') await producer(ctx, role);
  else if (role === 'inspect') await inspector(ctx);
  else throw new Error(`unknown role ${role}`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

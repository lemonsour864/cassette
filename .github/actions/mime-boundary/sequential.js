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
  let body = {}; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}

function field(result, snake) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return result.body[snake] || result.body[camel] || null;
}

function brief(result) {
  return { status: result.status, ok: result.body.ok,
    message: result.body.msg || result.body.message || result.body.code || '',
    hasUpload: Boolean(field(result, 'signed_upload_url')),
    artifactId: field(result, 'artifact_id') };
}

async function state(ctx, name) {
  const listed = await rpc(ctx, 'ListArtifacts', { name_filter: name });
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const url = field(signed, 'signed_url');
  return {
    listStatus: listed.status,
    records: (listed.body.artifacts || []).map((a) => ({
      id: a.database_id || a.databaseId || null,
      name: a.name,
      size: a.size,
      digest: a.digest && (a.digest.value || a.digest),
    })),
    signedStatus: signed.status,
    rsct: url ? new URL(url).searchParams.get('rsct') : null,
    blob: url ? crypto.createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0, 16) : null,
  };
}

async function uploadFinalize(ctx, name, created, marker) {
  const url = field(created, 'signed_upload_url');
  if (!url) return { skipped: true };
  const body = Buffer.from(JSON.stringify({ full_name: `sequential/${marker}`,
    owner: { login: marker, avatar_url: 'file:///proc/self/environ' }, marker }));
  const put = await fetch(url, { method: 'PUT', headers: {
    'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body,
  signal: AbortSignal.timeout(20000) });
  const finalized = await rpc(ctx, 'FinalizeArtifact', { name, size: String(body.length),
    hash: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}` });
  return { put: put.status, finalize: brief(finalized) };
}

async function scenario(ctx, label, steps) {
  const name = `sequential-${label}-${Date.now()}.json`;
  const out = { label, name, observations: [] };
  for (const [op, data] of steps) {
    if (op === 'create') {
      const { finish, ...createFields } = data;
      const result = await rpc(ctx, 'CreateArtifact', { name, ...createFields });
      out.observations.push({ op, args: createFields, result: brief(result), state: await state(ctx, name) });
      if (finish) {
        out.observations.push({ op: 'finish', result: await uploadFinalize(ctx, name, result, label),
          state: await state(ctx, name) });
      }
    } else if (op === 'delete') {
      const result = await rpc(ctx, 'DeleteArtifact', { name });
      out.observations.push({ op, result: brief(result), state: await state(ctx, name) });
    }
  }
  console.log('SEQUENTIAL ' + JSON.stringify(out));
}

(async () => {
  const ctx = context();
  const good = { version: 7, mime_type: 'application/json' };
  const bad = { version: 7, mime_type: '\u0085application/json' };
  const old = { version: 6, mime_type: '\u0085application/json' };
  await scenario(ctx, 'bad-then-good', [['create', bad], ['create', { ...good, finish: true }]]);
  await scenario(ctx, 'good-final-bad', [['create', { ...good, finish: true }], ['create', bad]]);
  await scenario(ctx, 'good-open-bad', [['create', good], ['create', bad]]);
  await scenario(ctx, 'old-final-bad', [['create', { ...old, finish: true }], ['create', bad]]);
  await scenario(ctx, 'good-final-old', [['create', { ...good, finish: true }], ['create', old]]);
  await scenario(ctx, 'good-delete-bad-good', [['create', { ...good, finish: true }], ['delete', {}],
    ['create', bad], ['create', { ...good, finish: true }]]);
})().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });

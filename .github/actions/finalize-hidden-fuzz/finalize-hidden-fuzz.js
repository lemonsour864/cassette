'use strict';

const crypto = require('node:crypto');
const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return {token, base, runId, jobId};
}

function varint(value) {
  let current = BigInt(value);
  const out = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    out.push(byte);
  } while (current);
  return Buffer.from(out);
}

function vi(number, value) {
  return Buffer.concat([varint(BigInt(number * 8)), varint(value)]);
}

function ld(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(BigInt(number * 8 + 2)), varint(bytes.length), bytes]);
}

function wrapper(value) { return ld(1, Buffer.from(value)); }

async function rawRpc(ctx, method, contentType, body) {
  const response = await fetch(ctx.base + SERVICE + method, {method: 'POST', headers: {
    Authorization: `Bearer ${ctx.token}`, 'Content-Type': contentType}, body,
  signal: AbortSignal.timeout(15000)});
  const text = await response.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  return {status: response.status, body: parsed, text: text.slice(0, 180)};
}

async function rpc(ctx, method, fields) {
  return rawRpc(ctx, method, 'application/json', JSON.stringify({
    workflow_run_backend_id: ctx.runId, workflow_job_run_backend_id: ctx.jobId, ...fields,
  }));
}

function get(result, key) {
  return result.body[key] || result.body[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] || null;
}

function finalizePrefix(ctx, name, payload) {
  return Buffer.concat([
    ld(1, ctx.runId), ld(2, ctx.jobId), ld(3, name), vi(4, payload.length),
    ld(5, `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`),
  ]);
}

async function one(ctx, label, finalizeMode) {
  const name = `finalize-hidden-${label}-${Date.now()}`.slice(0, 240);
  const payload = Buffer.from('{"probe":"finalize-hidden"}');
  const created = await rpc(ctx, 'CreateArtifact', {name, version: 6,
    mime_type: '\u0085application/json'});
  const uploadUrl = get(created, 'signed_upload_url');
  if (!uploadUrl) return {label, stage: 'create', status: created.status,
    message: created.body.msg || created.body.message || created.text};
  const upload = await fetch(uploadUrl, {method: 'PUT', headers: {
    'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob'}, body: payload,
  signal: AbortSignal.timeout(15000)});
  let finalized;
  if (finalizeMode.kind === 'pb') {
    finalized = await rawRpc(ctx, 'FinalizeArtifact', 'application/protobuf',
      Buffer.concat([finalizePrefix(ctx, name, payload), finalizeMode.extra]));
  } else {
    finalized = await rpc(ctx, 'FinalizeArtifact', {name, size: String(payload.length),
      hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
      [finalizeMode.key]: finalizeMode.value});
  }
  const signed = await rpc(ctx, 'GetSignedArtifactURL', {name});
  const signedUrl = get(signed, 'signed_url');
  let summary = {label, create: created.status, upload: upload.status,
    finalize: finalized.status, signed: signed.status,
    artifactId: get(finalized, 'artifact_id'), message:
      finalized.body.msg || finalized.body.message || (finalized.status === 200 ? '' : finalized.text)};
  if (signedUrl) {
    const url = new URL(signedUrl);
    summary.rsct = url.searchParams.get('rsct');
    summary.apiVersion = url.searchParams.get('api-version');
    summary.keys = [...new Set(url.searchParams.keys())].sort();
  }
  const changed = finalized.status !== 200 || signed.status !== 200 ||
    summary.rsct !== 'application/zip' || summary.apiVersion !== null;
  if (!changed) await rpc(ctx, 'DeleteArtifact', {name});
  return {changed, ...summary};
}

(async () => {
  const ctx = context();
  let cases = 0;
  let diffs = 0;
  // Build each field explicitly; bind tricks would obscure the protobuf tag.
  for (let number = 6; number <= 32; number += 1) {
    const values = [
      ['v0', vi(number, 0)], ['v1', vi(number, 1)], ['v6', vi(number, 6)],
      ['v7', vi(number, 7)], ['raw', ld(number, 'raw')],
      ['json', ld(number, 'application/json')],
      ['evil', ld(number, '\u0085application/json')],
      ['oldver', ld(number, '2009-09-19')],
      ['wrap-json', ld(number, wrapper('application/json'))],
      ['wrap-evil', ld(number, wrapper('\u0085application/json'))],
    ];
    for (const [kind, extra] of values) {
      const result = await one(ctx, `f${number}-${kind}`, {kind: 'pb', extra});
      cases += 1;
      if (result.changed || result.stage) { diffs += 1; console.log('DIFF ' + JSON.stringify(result)); }
    }
  }

  const jsonKeys = ['version', 'artifact_version', 'upload_version', 'protocol_version',
    'schema_version', 'mime_type', 'content_type', 'artifact_type', 'archive_format',
    'raw', 'is_raw', 'raw_artifact', 'storage_type', 'download_type', 'format'];
  const jsonValues = [7, true, 'raw', '\u0085application/json'];
  for (const key of jsonKeys) {
    for (const value of jsonValues) {
      const tag = `${key}-${typeof value === 'string' ? value.replace(/[^a-z0-9]/gi, '_') : value}`;
      const result = await one(ctx, `json-${tag}`, {kind: 'json', key, value});
      cases += 1;
      if (result.changed || result.stage) { diffs += 1; console.log('DIFF ' + JSON.stringify(result)); }
    }
  }
  console.log('DONE ' + JSON.stringify({cases, diffs}));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

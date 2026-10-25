'use strict';

const crypto = require('node:crypto');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
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

function field(number, wire, value) {
  const tag = varint(BigInt(number * 8 + wire));
  if (wire === 0) return Buffer.concat([tag, varint(value)]);
  if (wire === 1) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value));
    return Buffer.concat([tag, b]);
  }
  if (wire === 2) {
    const b = Buffer.from(value);
    return Buffer.concat([tag, varint(b.length), b]);
  }
  if (wire === 5) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(BigInt(value) & 0xffffffffn));
    return Buffer.concat([tag, b]);
  }
  throw new Error(`wire ${wire}`);
}

function wrapper(value) {
  return field(1, 2, Buffer.from(value));
}

function known(ctx, name) {
  return Buffer.concat([
    field(1, 2, Buffer.from(ctx.runId)),
    field(2, 2, Buffer.from(ctx.jobId)),
    field(3, 2, Buffer.from(name)),
  ]);
}

function parseFields(bytes) {
  let offset = 0;
  const out = [];
  function readVarint() {
    let value = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
      if (shift > 70n) throw new Error('oversized varint');
    }
    throw new Error('truncated varint');
  }
  while (offset < bytes.length) {
    const tag = Number(readVarint());
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push([number, wire, readVarint()]);
    else if (wire === 1) { out.push([number, wire, bytes.subarray(offset, offset + 8)]); offset += 8; }
    else if (wire === 2) {
      const length = Number(readVarint());
      out.push([number, wire, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else if (wire === 5) { out.push([number, wire, bytes.subarray(offset, offset + 4)]); offset += 4; }
    else throw new Error(`wire ${wire}`);
  }
  return out;
}

async function rawRpc(ctx, method, contentType, body) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: {Authorization: `Bearer ${ctx.token}`, 'Content-Type': contentType},
    body,
    signal: AbortSignal.timeout(15000),
  });
  return {status: response.status, type: response.headers.get('content-type'),
    bytes: Buffer.from(await response.arrayBuffer())};
}

async function jsonRpc(ctx, method, fields) {
  const request = {workflow_run_backend_id: ctx.runId,
    workflow_job_run_backend_id: ctx.jobId, ...fields};
  const result = await rawRpc(ctx, method, 'application/json', JSON.stringify(request));
  let body = {};
  try { body = JSON.parse(result.bytes.toString('utf8')); } catch {}
  return {...result, body};
}

function getSignedUrl(result) {
  if (result.type && result.type.startsWith('application/protobuf')) {
    try {
      const found = parseFields(result.bytes).find(([number, wire]) => number === 1 && wire === 2);
      return found ? Buffer.from(found[2]).toString('utf8') : null;
    } catch { return null; }
  }
  return result.body && (result.body.signed_url || result.body.signedUrl) || null;
}

function summarize(label, result) {
  const signed = getSignedUrl(result);
  if (!signed) {
    let message = '';
    try {
      const parsed = JSON.parse(result.bytes.toString('utf8'));
      message = String(parsed.msg || parsed.message || parsed.code || '').slice(0, 100);
    } catch { message = result.bytes.subarray(0, 80).toString('hex'); }
    return {label, status: result.status, type: result.type, message};
  }
  const url = new URL(signed);
  const keys = [...new Set([...url.searchParams.keys()])].sort();
  const summary = {label, status: result.status, host: url.host,
    pathHash: crypto.createHash('sha256').update(url.pathname).digest('hex').slice(0, 12),
    keys, rsct: url.searchParams.get('rsct'), apiVersion: url.searchParams.get('api-version'),
    sv: url.searchParams.get('sv'), skv: url.searchParams.get('skv')};
  return summary;
}

(async () => {
  const ctx = context();
  const name = `getsigned-fuzz-${Date.now()}.json`;
  const payload = Buffer.from('{"probe":"getsigned-hidden-fields"}');
  const created = await jsonRpc(ctx, 'CreateArtifact', {name, version: 7, mime_type: 'application/json'});
  const uploadUrl = created.body.signed_upload_url || created.body.signedUploadUrl;
  if (!uploadUrl) throw new Error(`create failed ${created.status}`);
  const uploaded = await fetch(uploadUrl, {method: 'PUT', headers: {
    'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob'}, body: payload});
  const finalized = await jsonRpc(ctx, 'FinalizeArtifact', {name, size: String(payload.length),
    hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`});
  console.log('SETUP ' + JSON.stringify({create: created.status, upload: uploaded.status,
    finalize: finalized.status, artifactId: finalized.body.artifact_id || finalized.body.artifactId || null}));

  const prefix = known(ctx, name);
  const baseline = await rawRpc(ctx, 'GetSignedArtifactURL', 'application/protobuf', prefix);
  const baselineSummary = summarize('baseline', baseline);
  console.log('BASELINE ' + JSON.stringify(baselineSummary));

  const variants = [
    ['v0', 0, 0n], ['v1', 0, 1n], ['v6', 0, 6n], ['v7', 0, 7n],
    ['v2009', 0, 20090919n], ['fix32-1', 5, 1n], ['fix64-1', 1, 1n],
    ['raw', 2, Buffer.from('raw')], ['zip', 2, Buffer.from('zip')],
    ['json', 2, Buffer.from('application/json')],
    ['evil', 2, Buffer.from('\u0085application/json')],
    ['oldver', 2, Buffer.from('2009-09-19')],
    ['oldquery', 2, Buffer.from('api-version=2009-09-19')],
    ['wrap-json', 2, wrapper('application/json')],
    ['wrap-evil', 2, wrapper('\u0085application/json')],
    ['wrap-oldver', 2, wrapper('2009-09-19')],
  ];
  // The first run covered 4..40; the committed follow-up covers the remaining
  // one-byte protobuf field-number space without repeating those cases.
  for (let number = 41; number <= 127; number += 1) {
    for (const [kind, wire, value] of variants) {
      const label = `f${number}-${kind}`;
      try {
        const body = Buffer.concat([prefix, field(number, wire, value)]);
        const result = await rawRpc(ctx, 'GetSignedArtifactURL', 'application/protobuf', body);
        const summary = summarize(label, result);
        const changed = summary.status !== baselineSummary.status || summary.host !== baselineSummary.host ||
          summary.pathHash !== baselineSummary.pathHash || summary.rsct !== baselineSummary.rsct ||
          summary.apiVersion !== baselineSummary.apiVersion || summary.sv !== baselineSummary.sv ||
          JSON.stringify(summary.keys) !== JSON.stringify(baselineSummary.keys);
        if (changed || result.status !== 200) console.log('DIFF ' + JSON.stringify(summary));
      } catch (error) {
        console.log('ERROR ' + JSON.stringify({label, error: `${error.name}:${error.message}`}));
      }
    }
  }

  const jsonNames = [
    'version', 'artifact_version', 'archive_format', 'format', 'mime_type', 'content_type',
    'response_content_type', 'rsct', 'api_version', 'x_ms_version', 'raw', 'skip_decompress',
    'download_type', 'artifact_id', 'file_name', 'path', 'use_stored_content_type',
    'preserve_content_type', 'disable_content_type_override', 'include_files',
  ];
  const jsonValues = [true, 1, 7, 'raw', 'application/json', '\u0085application/json', '2009-09-19'];
  for (const key of jsonNames) {
    for (const value of jsonValues) {
      const label = `json-${key}-${typeof value === 'string' ? value.replace(/[^a-z0-9]/gi, '_') : value}`;
      try {
        const fields = {name};
        fields[key] = value;
        const result = await jsonRpc(ctx, 'GetSignedArtifactURL', fields);
        const summary = summarize(label, result);
        const changed = summary.status !== baselineSummary.status || summary.host !== baselineSummary.host ||
          summary.pathHash !== baselineSummary.pathHash || summary.rsct !== baselineSummary.rsct ||
          summary.apiVersion !== baselineSummary.apiVersion || summary.sv !== baselineSummary.sv ||
          JSON.stringify(summary.keys) !== JSON.stringify(baselineSummary.keys);
        if (changed || result.status !== 200) console.log('JSONDIFF ' + JSON.stringify(summary));
      } catch (error) {
        console.log('ERROR ' + JSON.stringify({label, error: `${error.name}:${error.message}`}));
      }
    }
  }
  console.log('DONE');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

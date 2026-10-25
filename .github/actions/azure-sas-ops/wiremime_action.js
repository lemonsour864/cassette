'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const SOURCE_ARTIFACT = '12597869930';
const SAFE = Buffer.from('application/json', 'ascii');
const UTF8_NEL = Buffer.concat([Buffer.from([0xc2, 0x85]), SAFE]);
const RAW85 = Buffer.concat([Buffer.from([0x85]), SAFE]);

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
  const output = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    output.push(byte);
  } while (current);
  return Buffer.from(output);
}

function overlongSmall(value, padding = 1) {
  if (value < 0 || value >= 0x80 || padding < 1) throw new Error('overlongSmall bounds');
  return Buffer.from([value | 0x80, ...Array(padding - 1).fill(0x80), 0x00]);
}

function tag(number, wire) {
  return varint(BigInt(number * 8 + wire));
}

function ld(number, bytes) {
  const value = Buffer.from(bytes);
  return Buffer.concat([tag(number, 2), varint(value.length), value]);
}

function ldEncoded(tagBytes, lengthBytes, bytes) {
  return Buffer.concat([Buffer.from(tagBytes), Buffer.from(lengthBytes), Buffer.from(bytes)]);
}

function vi(number, valueBytes) {
  return Buffer.concat([tag(number, 0), Buffer.from(valueBytes)]);
}

function innerString(bytes) {
  return ld(1, bytes);
}

function mime(bytes) {
  return ld(6, innerString(bytes));
}

function outerWrapper(inner) {
  return ld(6, inner);
}

function prefix(ctx, name, versionBytes = varint(7)) {
  return Buffer.concat([
    ld(1, Buffer.from(ctx.runId)),
    ld(2, Buffer.from(ctx.jobId)),
    ld(3, Buffer.from(name)),
    vi(5, versionBytes),
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
      if (shift > 70n) throw new Error('oversized varint');
    }
    throw new Error('truncated varint');
  }
  while (offset < bytes.length) {
    const rawTag = Number(readVarint());
    const number = rawTag >> 3;
    const wire = rawTag & 7;
    if (wire === 0) fields.push([number, wire, readVarint()]);
    else if (wire === 2) {
      const length = Number(readVarint());
      if (offset + length > bytes.length) throw new Error('truncated field');
      fields.push([number, wire, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error(`unsupported response wire ${wire}`);
  }
  return fields;
}

function decodeError(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return { code: value.code || '', message: String(value.msg || value.message || '').slice(0, 180) };
  } catch {
    return { responseHex: bytes.subarray(0, 100).toString('hex') };
  }
}

async function createBinary(ctx, name, extra, versionBytes) {
  const body = Buffer.concat([prefix(ctx, name, versionBytes), extra]);
  const response = await fetch(ctx.base + SERVICE + 'CreateArtifact', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/protobuf' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let upload = null;
  if (response.ok) {
    try {
      const field = parseFields(bytes).find(([number, wire]) => number === 2 && wire === 2);
      if (field) upload = Buffer.from(field[2]).toString('utf8');
    } catch {}
  }
  return { status: response.status, upload, ...(!upload ? decodeError(bytes) : {}) };
}

function jsonPrefix(ctx, name) {
  return `{"workflow_run_backend_id":${JSON.stringify(ctx.runId)},` +
    `"workflow_job_run_backend_id":${JSON.stringify(ctx.jobId)},` +
    `"name":${JSON.stringify(name)},`;
}

function jsonObject(ctx, name, fields) {
  return Buffer.from(jsonPrefix(ctx, name) + fields + '}', 'utf8');
}

function jsonRawMime(ctx, name, bytes) {
  return Buffer.concat([
    Buffer.from(jsonPrefix(ctx, name) + '"version":7,"mime_type":"', 'utf8'),
    Buffer.from(bytes),
    Buffer.from('"}', 'utf8'),
  ]);
}

async function createJson(ctx, name, body, contentType) {
  const response = await fetch(ctx.base + SERVICE + 'CreateArtifact', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let value = {};
  try { value = JSON.parse(bytes.toString('utf8')); } catch {}
  const upload = value.signed_upload_url || value.signedUploadUrl || null;
  return { status: response.status, upload,
    ...(!upload ? { code: value.code || '', message: String(value.msg || value.message || '').slice(0, 180),
      responseHex: Object.keys(value).length ? '' : bytes.subarray(0, 100).toString('hex') } : {}) };
}

async function rpc(ctx, method, fields) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body };
}

function field(result, snake) {
  const camel = snake.replace(/_([a-z])/g, (_, value) => value.toUpperCase());
  return result.body[snake] || result.body[camel] || null;
}

function contentTypeHex(response) {
  const values = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index].toLowerCase() === 'content-type') {
      values.push(Buffer.from(response.rawHeaders[index + 1], 'latin1').toString('hex'));
    }
  }
  return values;
}

function httpRequest(target, options = {}) {
  return new Promise((resolve) => {
    const request = https.request(target, { method: options.method || 'GET',
      headers: options.headers || {}, timeout: 30000, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const match = /<Code>([^<]{1,80})<\/Code>/.exec(body.toString('utf8'));
        resolve({ status: response.statusCode, contentTypeHex: contentTypeHex(response), body,
          length: body.length, sha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
          errorCode: response.headers['x-ms-error-code'] || (match && match[1]) || '' });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ error: `${error.code || error.name}:${error.message}`,
      body: Buffer.alloc(0), contentTypeHex: [] }));
    request.end(options.body);
  });
}

function safeHttp(result) {
  return { status: result.status || null, contentTypeHex: result.contentTypeHex || [],
    length: result.length || 0, sha: result.sha || '', errorCode: result.errorCode || '', error: result.error || '' };
}

async function sourceArtifact() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN unavailable');
  const response = await fetch(`https://api.github.com/repos/lemonsour864/cassette/actions/artifacts/${SOURCE_ARTIFACT}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) throw new Error(`source redirect ${response.status}`);
  const oldUrl = location + (location.includes('?') ? '&' : '?') + 'api-version=2009-09-19';
  const check = await httpRequest(oldUrl);
  if (check.status !== 200 || !check.contentTypeHex.includes('856170706c69636174696f6e2f6a736f6e')) {
    throw new Error(`source check ${JSON.stringify(safeHttp(check))}`);
  }
  console.log('SOURCE ' + JSON.stringify({ artifactId: SOURCE_ARTIFACT,
    rest: response.status, oldApi: safeHttp(check) }));
  return { url: oldUrl, body: check.body };
}

function rsctData(url) {
  if (!url) return { rsct: null, rsctEncoded: null, rsctCodepoints: null };
  const parsed = new URL(url);
  const rsct = parsed.searchParams.get('rsct');
  const raw = /(?:^|[?&])rsct=([^&]*)/.exec(parsed.search);
  return { rsct, rsctEncoded: raw ? raw[1] : null,
    rsctCodepoints: rsct === null ? null : Array.from(rsct, (character) => character.codePointAt(0).toString(16)).join(',') };
}

async function lifecycle(ctx, name, upload, source) {
  const uploadPermission = new URL(upload).searchParams.get('sp');
  const copied = await httpRequest(upload, { method: 'PUT', headers: {
    'Content-Length': '0', 'x-ms-version': '2021-08-06', 'x-ms-copy-source': source.url,
    'x-ms-blob-type': 'BlockBlob', 'x-ms-copy-source-blob-properties': 'true',
  }});
  let finalized = { status: null, body: {} };
  if (copied.status === 201) {
    finalized = await rpc(ctx, 'FinalizeArtifact', { name, size: String(source.body.length),
      hash: `sha256:${crypto.createHash('sha256').update(source.body).digest('hex')}` });
  }
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
  const download = field(signed, 'signed_url');
  let normal = null;
  let storedOld = null;
  if (download) {
    normal = safeHttp(await httpRequest(download));
    storedOld = safeHttp(await httpRequest(download, { headers: { 'x-ms-version': '2009-09-19' } }));
  }
  return { uploadPermission, putFromUrl: safeHttp(copied), finalize: finalized.status,
    artifactId: field(finalized, 'artifact_id'), signed: signed.status, ...rsctData(download), normal, storedOld };
}

function binaryCases() {
  const emptyInner = innerString(Buffer.alloc(0));
  const unknownInner = ld(2, RAW85);
  const wrong6Varint = Buffer.concat([tag(6, 0), varint(0)]);
  const wrong6Fixed64 = Buffer.concat([tag(6, 1), Buffer.from([0x85, 1, 2, 3, 4, 5, 6, 7])]);
  const wrong6Fixed32 = Buffer.concat([tag(6, 5), Buffer.from([0x85, 1, 2, 3])]);
  const wrong6Group = Buffer.concat([tag(6, 3), ld(1, RAW85), tag(6, 4)]);
  const safeWrapper = innerString(SAFE);
  const wrapperLength = safeWrapper.length;
  return [
    ['control-safe', mime(SAFE)],
    ['outer-evil-safe', Buffer.concat([mime(UTF8_NEL), mime(SAFE)])],
    ['outer-safe-evil', Buffer.concat([mime(SAFE), mime(UTF8_NEL)])],
    ['outer-safe-empty-wrapper', Buffer.concat([mime(SAFE), outerWrapper(Buffer.alloc(0))])],
    ['outer-empty-wrapper-safe', Buffer.concat([outerWrapper(Buffer.alloc(0)), mime(SAFE)])],
    ['outer-safe-unknown-wrapper-raw85', Buffer.concat([mime(SAFE), outerWrapper(unknownInner)])],
    ['outer-unknown-wrapper-raw85-safe', Buffer.concat([outerWrapper(unknownInner), mime(SAFE)])],
    ['outer-safe-explicit-empty', Buffer.concat([mime(SAFE), outerWrapper(emptyInner)])],
    ['outer-explicit-empty-safe', Buffer.concat([outerWrapper(emptyInner), mime(SAFE)])],
    ['inner-safe-empty', outerWrapper(Buffer.concat([innerString(SAFE), emptyInner]))],
    ['inner-empty-safe', outerWrapper(Buffer.concat([emptyInner, innerString(SAFE)]))],
    ['triple-safe-evil-safe', Buffer.concat([mime(SAFE), mime(UTF8_NEL), mime(SAFE)])],
    ['triple-evil-safe-evil', Buffer.concat([mime(UTF8_NEL), mime(SAFE), mime(UTF8_NEL)])],
    ['unknown-outer-raw85-before-safe', Buffer.concat([ld(15, RAW85), mime(SAFE)])],
    ['unknown-outer-raw85-after-safe', Buffer.concat([mime(SAFE), ld(15, RAW85)])],
    ['wrong6-varint-before-safe', Buffer.concat([wrong6Varint, mime(SAFE)])],
    ['wrong6-varint-after-safe', Buffer.concat([mime(SAFE), wrong6Varint])],
    ['wrong6-fixed64-before-safe', Buffer.concat([wrong6Fixed64, mime(SAFE)])],
    ['wrong6-fixed64-after-safe', Buffer.concat([mime(SAFE), wrong6Fixed64])],
    ['wrong6-fixed32-before-safe', Buffer.concat([wrong6Fixed32, mime(SAFE)])],
    ['wrong6-fixed32-after-safe', Buffer.concat([mime(SAFE), wrong6Fixed32])],
    ['wrong6-group-before-safe', Buffer.concat([wrong6Group, mime(SAFE)])],
    ['wrong6-group-after-safe', Buffer.concat([mime(SAFE), wrong6Group])],
    ['wrong6-reserved6-after-safe', Buffer.concat([mime(SAFE), tag(6, 6)])],
    ['wrong6-reserved7-after-safe', Buffer.concat([mime(SAFE), tag(6, 7)])],
    ['wrong-inner-varint-after-safe', outerWrapper(Buffer.concat([innerString(SAFE), tag(1, 0), varint(0)]))],
    ['wrong-inner-varint-before-safe', outerWrapper(Buffer.concat([tag(1, 0), varint(0), innerString(SAFE)]))],
    ['packed-raw-string-vector', outerWrapper(Buffer.concat([varint(SAFE.length), SAFE]))],
    ['raw-string-not-wrapper-before-safe', Buffer.concat([outerWrapper(SAFE), mime(SAFE)])],
    ['raw-string-not-wrapper-after-safe', Buffer.concat([mime(SAFE), outerWrapper(SAFE)])],
    ['noncanonical-outer-tag-1pad', ldEncoded(overlongSmall(0x32), varint(wrapperLength), safeWrapper)],
    ['noncanonical-outer-tag-8pad', ldEncoded(overlongSmall(0x32, 8), varint(wrapperLength), safeWrapper)],
    ['noncanonical-outer-length-1pad', ldEncoded(tag(6, 2), overlongSmall(wrapperLength), safeWrapper)],
    ['noncanonical-outer-length-8pad', ldEncoded(tag(6, 2), overlongSmall(wrapperLength, 8), safeWrapper)],
    ['noncanonical-inner-tag', outerWrapper(ldEncoded(overlongSmall(0x0a), varint(SAFE.length), SAFE))],
    ['noncanonical-inner-length', outerWrapper(ldEncoded(tag(1, 2), overlongSmall(SAFE.length), SAFE))],
    ['noncanonical-all', ldEncoded(overlongSmall(0x32), overlongSmall(wrapperLength + 2),
      ldEncoded(overlongSmall(0x0a), overlongSmall(SAFE.length), SAFE))],
    ['noncanonical-version-safe', mime(SAFE), overlongSmall(7)],
    ['invalid-raw85-prefix', mime(RAW85)],
    ['invalid-raw85-suffix', mime(Buffer.concat([SAFE, Buffer.from([0x85])]))],
    ['valid-utf8-u0085-prefix', mime(UTF8_NEL)],
    ['valid-utf8-u0085-suffix', mime(Buffer.concat([SAFE, Buffer.from([0xc2, 0x85])]))],
    ['invalid-overlong2-u0005', mime(Buffer.concat([Buffer.from([0xc0, 0x85]), SAFE]))],
    ['invalid-overlong3-u0085', mime(Buffer.concat([Buffer.from([0xe0, 0x82, 0x85]), SAFE]))],
    ['invalid-overlong4-u0085', mime(Buffer.concat([Buffer.from([0xf0, 0x80, 0x82, 0x85]), SAFE]))],
    ['invalid-surrogate', mime(Buffer.concat([Buffer.from([0xed, 0xa0, 0x80]), SAFE]))],
    ['invalid-lone-continuation', mime(Buffer.concat([Buffer.from([0x80]), SAFE]))],
    ['invalid-ff-prefix', mime(Buffer.concat([Buffer.from([0xff]), SAFE]))],
    ['embedded-nul-prefix', mime(Buffer.concat([Buffer.from([0x00]), SAFE]))],
    ['embedded-nul-suffix', mime(Buffer.concat([SAFE, Buffer.from([0x00])]))],
    ...[0x1c, 0x1d, 0x1e, 0x1f].flatMap((value) => [
      [`control-${value.toString(16)}-prefix`, mime(Buffer.concat([Buffer.from([value]), SAFE]))],
      [`control-${value.toString(16)}-suffix`, mime(Buffer.concat([SAFE, Buffer.from([value])]))],
    ]),
    ['safe-then-trailing-tag-zero', Buffer.concat([mime(SAFE), Buffer.from([0x00])])],
    ['outer-length-too-long', ldEncoded(tag(6, 2), varint(wrapperLength + 1), safeWrapper)],
    ['outer-length-too-short', ldEncoded(tag(6, 2), varint(wrapperLength - 1), safeWrapper)],
    ['inner-length-too-long', outerWrapper(ldEncoded(tag(1, 2), varint(SAFE.length + 1), SAFE))],
  ];
}

function jsonCases(ctx) {
  const safe = JSON.stringify('application/json');
  const evil = JSON.stringify('\u0085application/json');
  const ordinary = (name, fields) => jsonObject(ctx, name, fields);
  return [
    ['control-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe}`)],
    ['dup-safe-evil', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mime_type":${evil}`)],
    ['dup-evil-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${evil},"mime_type":${safe}`)],
    ['dup-safe-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mime_type":${safe}`)],
    ['alias-safe-evil', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mimeType":${evil}`)],
    ['alias-evil-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${evil},"mimeType":${safe}`)],
    ['camel-only-safe', 'application/json', (name) => ordinary(name, `"version":7,"mimeType":${safe}`)],
    ['escaped-key-only-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime\\u005ftype":${safe}`)],
    ['escaped-letter-dup', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"m\\u0069me_type":${evil}`)],
    ['dup-safe-null', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mime_type":null`)],
    ['dup-null-safe', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":null,"mime_type":${safe}`)],
    ['mime-null', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":null')],
    ['mime-wrapper-object', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":{"value":${safe}}`)],
    ['mime-array', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":[${safe}]`)],
    ['mime-number', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":1')],
    ['unknown-shadow-evil', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mime_type_shadow":${evil}`)],
    ['unknown-nul-key-evil', 'application/json', (name) => ordinary(name, `"version":7,"mime_type":${safe},"mime_type\\u0000":${evil}`)],
    ['u0085-escape-prefix', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":"\\u0085application/json"')],
    ['u0085-escape-suffix', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":"application/json\\u0085"')],
    ['nul-escape-prefix', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":"\\u0000application/json"')],
    ['nul-escape-suffix', 'application/json', (name) => ordinary(name, '"version":7,"mime_type":"application/json\\u0000"')],
    ...[0x1c, 0x1d, 0x1e, 0x1f].flatMap((value) => {
      const escape = `\\u00${value.toString(16)}`;
      return [
        [`control-${value.toString(16)}-escape-prefix`, 'application/json', (name) => ordinary(name, `"version":7,"mime_type":"${escape}application/json"`)],
        [`control-${value.toString(16)}-escape-suffix`, 'application/json', (name) => ordinary(name, `"version":7,"mime_type":"application/json${escape}"`)],
      ];
    }),
    ['raw-valid-u0085-in-string', 'application/json', (name) => jsonRawMime(ctx, name, UTF8_NEL)],
    ['raw-invalid-85-in-string', 'application/json', (name) => jsonRawMime(ctx, name, RAW85)],
    ['raw-overlong3-in-string', 'application/json', (name) => jsonRawMime(ctx, name, Buffer.concat([Buffer.from([0xe0, 0x82, 0x85]), SAFE]))],
    ['raw-nul-in-string', 'application/json', (name) => jsonRawMime(ctx, name, Buffer.concat([SAFE, Buffer.from([0x00])]))],
    ['utf8-bom-prefix-body', 'application/json', (name) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ordinary(name, `"version":7,"mime_type":${safe}`)])],
    ['u0085-prefix-body', 'application/json', (name) => Buffer.concat([Buffer.from([0xc2, 0x85]), ordinary(name, `"version":7,"mime_type":${safe}`)])],
    ['raw85-prefix-body', 'application/json', (name) => Buffer.concat([Buffer.from([0x85]), ordinary(name, `"version":7,"mime_type":${safe}`)])],
    ['standard-whitespace-frame', 'application/json', (name) => Buffer.concat([Buffer.from(' \r\n\t'), ordinary(name, `"version":7,"mime_type":${safe}`), Buffer.from('\r\n\t ')])],
    ['trailing-nul-body', 'application/json', (name) => Buffer.concat([ordinary(name, `"version":7,"mime_type":${safe}`), Buffer.from([0x00])])],
    ['trailing-1c-body', 'application/json', (name) => Buffer.concat([ordinary(name, `"version":7,"mime_type":${safe}`), Buffer.from([0x1c])])],
    ['trailing-second-object', 'application/json', (name) => Buffer.concat([ordinary(name, `"version":7,"mime_type":${safe}`), Buffer.from('{}')])],
    ['field-order-mime-before-version', 'application/json', (name) => ordinary(name, `"mime_type":${safe},"version":7`)],
    ['charset-content-type', 'application/json; charset=utf-8', (name) => ordinary(name, `"version":7,"mime_type":${safe}`)],
    ['compact-charset-content-type', 'application/json;charset=UTF-8', (name) => ordinary(name, `"version":7,"mime_type":${safe}`)],
    ['arbitrary-param-content-type', 'application/json; x-test=1', (name) => ordinary(name, `"version":7,"mime_type":${safe}`)],
    ['uppercase-content-type', 'Application/JSON', (name) => ordinary(name, `"version":7,"mime_type":${safe}`)],
  ];
}

(async () => {
  const ctx = context();
  const source = await sourceArtifact();
  const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  let sequence = 0;
  const accepted = [];

  for (const item of binaryCases()) {
    const [label, extra, versionBytes] = item;
    const name = `wire-b-${stamp}-${sequence++}.json`;
    const result = await createBinary(ctx, name, extra, versionBytes);
    const output = { protocol: 'protobuf', label, extraHex: extra.toString('hex'),
      versionHex: (versionBytes || varint(7)).toString('hex'), create: result.status,
      accepted: Boolean(result.upload), code: result.code || '', message: result.message || '',
      responseHex: result.responseHex || '' };
    if (result.upload) {
      Object.assign(output, await lifecycle(ctx, name, result.upload, source));
      accepted.push({ protocol: 'protobuf', label, artifactId: output.artifactId,
        rsct: output.rsct, normal: output.normal && output.normal.contentTypeHex,
        storedOld: output.storedOld && output.storedOld.contentTypeHex });
    }
    console.log('WIRE_CASE ' + JSON.stringify(output));
  }

  for (const [label, contentType, makeBody] of jsonCases(ctx)) {
    const name = `wire-j-${stamp}-${sequence++}.json`;
    const body = makeBody(name);
    const result = await createJson(ctx, name, body, contentType);
    const output = { protocol: 'json', label, contentType, bodyLength: body.length,
      bodySha: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
      create: result.status, accepted: Boolean(result.upload), code: result.code || '',
      message: result.message || '', responseHex: result.responseHex || '' };
    if (result.upload) {
      Object.assign(output, await lifecycle(ctx, name, result.upload, source));
      accepted.push({ protocol: 'json', label, artifactId: output.artifactId,
        rsct: output.rsct, normal: output.normal && output.normal.contentTypeHex,
        storedOld: output.storedOld && output.storedOld.contentTypeHex });
    }
    console.log('WIRE_CASE ' + JSON.stringify(output));
  }

  console.log('WIRE_SUMMARY ' + JSON.stringify({ runId: ctx.runId, jobId: ctx.jobId,
    totalAccepted: accepted.length, accepted }));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

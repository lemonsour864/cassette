'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find((value) => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return { token, base, runId, jobId };
}

async function rpc(ctx, method, fields, timeout = 30000) {
  const response = await fetch(ctx.base + SERVICE + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_run_backend_id: ctx.runId,
      workflow_job_run_backend_id: ctx.jobId, ...fields }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  return { status: response.status, body };
}

function field(result, snake) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return result.body[snake] || result.body[camel] || null;
}

function hexHeader(response, name) {
  const wanted = name.toLowerCase();
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === wanted) {
      values.push(Buffer.from(response.rawHeaders[i + 1], 'latin1').toString('hex'));
    }
  }
  return values;
}

function request(target, options = {}) {
  return new Promise((resolve) => {
    const req = https.request(target, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false,
      timeout: 25000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        const xmlCode = /<Code>([^<]{1,80})<\/Code>/.exec(text);
        const output = {
          status: response.statusCode,
          contentTypeHex: hexHeader(response, 'content-type'),
          errorCode: response.headers['x-ms-error-code'] || (xmlCode && xmlCode[1]) || '',
          copyStatus: response.headers['x-ms-copy-status'] || '',
          length: body.length,
        };
        if ((options.method || 'GET') === 'GET' && response.statusCode < 400) {
          output.sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
        }
        resolve(output);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ error: `${error.code || error.name}:${error.message}` }));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function append(target, suffix) {
  return target + (target.includes('?') ? '&' : '?') + suffix;
}

function prepend(target, prefix) {
  const mark = target.indexOf('?');
  if (mark < 0) return target + '?' + prefix;
  return target.slice(0, mark + 1) + prefix + '&' + target.slice(mark + 1);
}

async function create(ctx, label, version, mime) {
  const name = `azurect-${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
  const made = await rpc(ctx, 'CreateArtifact', { name, version, mime_type: mime });
  return { name, made, upload: field(made, 'signed_upload_url') };
}

async function finalize(ctx, item, body) {
  const result = await rpc(ctx, 'FinalizeArtifact', {
    name: item.name,
    size: String(body.length),
    hash: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
  }, 60000);
  const signed = await rpc(ctx, 'GetSignedArtifactURL', { name: item.name });
  return { finalize: result.status, artifactId: field(result, 'artifact_id'),
    signedStatus: signed.status, download: field(signed, 'signed_url') };
}

function sasShape(target) {
  const parsed = new URL(target);
  const keep = {};
  for (const key of ['sp', 'sv', 'sr', 'rsct', 'rscd', 'api-version']) {
    if (parsed.searchParams.has(key)) {
      const value = parsed.searchParams.get(key) || '';
      keep[key] = key.startsWith('rs') ? Array.from(value, (c) => c.codePointAt(0).toString(16)).join(',') : value;
    }
  }
  return { host: parsed.hostname, keys: Array.from(parsed.searchParams.keys()), keep };
}

async function directInspects(target) {
  return {
    current: await request(target),
    oldHeader: await request(target, { headers: { 'x-ms-version': '2009-09-19' } }),
    oldQuery: await request(append(target, 'api-version=2009-09-19')),
  };
}

async function copyDestination(ctx, label, source, kind, body, extra = {}) {
  const item = await create(ctx, label, 7, 'application/json');
  const output = { label, create: item.made.status, hasUpload: Boolean(item.upload) };
  if (!item.upload) return output;
  const headers = {
    'Content-Length': '0',
    'x-ms-version': '2021-08-06',
    'x-ms-copy-source': source,
  };
  if (kind === 'put-from-url') headers['x-ms-blob-type'] = 'BlockBlob';
  if (extra.sourceProperties !== undefined) {
    headers['x-ms-copy-source-blob-properties'] = extra.sourceProperties ? 'true' : 'false';
  }
  const operation = await request(item.upload, { method: 'PUT', headers });
  output.operation = operation;
  // Register the copied blob so GetSignedArtifactURL gives us a read SAS.  Suppressing
  // its v7 rsct then reveals the actual copied Content-Type property.
  if (operation.status === 201 || operation.status === 202) {
    const done = await finalize(ctx, item, body);
    output.finalize = done.finalize;
    output.artifactId = done.artifactId;
    output.signedStatus = done.signedStatus;
    if (done.download) output.inspect = await directInspects(done.download);
  }
  return output;
}

(async () => {
  const ctx = context();
  const payloadLegacy = Buffer.from('{"source":"legacy-high","ok":true}');
  const payloadNel = Buffer.from('{"source":"raw-nel-header","ok":true}');

  // Source A: version 6 metadata emits U+0185 through rsct, which becomes raw 0x85 on the wire.
  const legacy = await create(ctx, 'legacy-source', 6, '\u0185application/json');
  const legacyOut = { create: legacy.made.status, hasUpload: Boolean(legacy.upload) };
  if (legacy.upload) {
    legacyOut.upload = await request(legacy.upload, { method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob',
      'Content-Length': String(payloadLegacy.length),
    }, body: payloadLegacy });
    Object.assign(legacyOut, await finalize(ctx, legacy, payloadLegacy));
    legacyOut.uploadSas = sasShape(legacy.upload);
    if (legacyOut.download) {
      legacyOut.downloadSas = sasShape(legacyOut.download);
      legacyOut.signedResponse = await request(legacyOut.download);
      legacyOut.signedOldHeader = await request(legacyOut.download,
        { headers: { 'x-ms-version': '2009-09-19' } });
      legacyOut.signedOldQuery = await request(append(legacyOut.download, 'api-version=2009-09-19'));
    }
  }
  console.log('SOURCE_LEGACY ' + JSON.stringify({ ...legacyOut, download: undefined }));

  // Source B: upload a literal 0x85 property through the ordinary request-header path.
  const nel = await create(ctx, 'nel-source', 7, 'application/json');
  const nelOut = { create: nel.made.status, hasUpload: Boolean(nel.upload) };
  if (nel.upload) {
    nelOut.upload = await request(nel.upload, { method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream',
      'x-ms-blob-content-type': String.fromCharCode(0x85) + 'application/json',
      'x-ms-blob-type': 'BlockBlob', 'Content-Length': String(payloadNel.length),
    }, body: payloadNel });
    Object.assign(nelOut, await finalize(ctx, nel, payloadNel));
    if (nelOut.download) {
      nelOut.signedResponse = await request(nelOut.download);
      nelOut.signedOldHeader = await request(nelOut.download,
        { headers: { 'x-ms-version': '2009-09-19' } });
      nelOut.signedOldQuery = await request(append(nelOut.download, 'api-version=2009-09-19'));
    }
  }
  console.log('SOURCE_NEL ' + JSON.stringify({ ...nelOut, download: undefined }));

  if (legacyOut.download && nelOut.download) {
    const cases = [
      ['pbf-legacy-default', legacyOut.download, 'put-from-url', payloadLegacy, {}],
      ['pbf-legacy-copyprops', legacyOut.download, 'put-from-url', payloadLegacy, { sourceProperties: true }],
      ['pbf-legacy-noprops', legacyOut.download, 'put-from-url', payloadLegacy, { sourceProperties: false }],
      ['copy-legacy', legacyOut.download, 'copy', payloadLegacy, {}],
      ['pbf-nel-stored', nelOut.download, 'put-from-url', payloadNel, { sourceProperties: true }],
      ['copy-nel-stored', nelOut.download, 'copy', payloadNel, {}],
    ];
    for (const args of cases) {
      try { console.log('COPY ' + JSON.stringify(await copyDestination(ctx, ...args))); }
      catch (error) { console.log('COPY ' + JSON.stringify({ label: args[0], error: `${error.name}:${error.message}` })); }
    }
  }

  if (legacyOut.download) {
    const target = legacyOut.download;
    const tests = [
      ['baseline', target, {}],
      ['old-header', target, { headers: { 'x-ms-version': '2009-09-19' } }],
      ['api-old', append(target, 'api-version=2009-09-19'), {}],
      ['api-pre-rsct-latest', append(target, 'api-version=2012-02-12'), {}],
      ['api-rsct-first', append(target, 'api-version=2013-08-15'), {}],
      ['api-modern', append(target, 'api-version=2021-08-06'), {}],
      ['api-old-header-modern', append(target, 'api-version=2009-09-19'),
        { headers: { 'x-ms-version': '2021-08-06' } }],
      ['api-modern-header-old', append(target, 'api-version=2021-08-06'),
        { headers: { 'x-ms-version': '2009-09-19' } }],
      ['dup-api-old-new', append(target, 'api-version=2009-09-19&api-version=2021-08-06'), {}],
      ['dup-api-new-old', append(target, 'api-version=2021-08-06&api-version=2009-09-19'), {}],
      ['dup-api-prepend-old', prepend(target, 'api-version=2009-09-19'), {}],
      ['dup-rsct-same', append(target, 'rsct=%C6%85application%2Fjson'), {}],
      ['dup-rsct-safe', append(target, 'rsct=application%2Fjson'), {}],
      ['dup-rsct-empty', append(target, 'rsct='), {}],
      ['dup-rsct-prepend-safe', prepend(target, 'rsct=application%2Fjson'), {}],
      ['case-RSCT-safe', append(target, 'RSCT=application%2Fjson'), {}],
      ['encoded-rsct-safe', append(target, '%72sct=application%2Fjson'), {}],
      ['response-content-type', append(target, 'response-content-type=application%2Fjson'), {}],
    ];
    for (const [label, url, options] of tests) {
      console.log('QUERY ' + JSON.stringify({ label, result: await request(url, options) }));
    }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

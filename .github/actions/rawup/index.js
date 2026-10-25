const fs = require('fs');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!token) { console.log('NO TOKEN'); process.exit(1); }
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  const name = process.env.INPUT_ARTNAME || 'payload.json';
  const mime = process.env.INPUT_MIMETYPE || 'application/xml';
  const r = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name: name, mime_type: mime, version: 7 })
  });
  const j = await r.json().catch(() => ({}));
  const up = j.signedUploadUrl || j.signed_upload_url;
  console.log('CreateArtifact HTTP', r.status, 'ok:', j.ok, 'err:', JSON.stringify(j.error || j).slice(0, 200));
  if (!up) process.exit(1);
  fs.writeFileSync('/tmp/rawup_state.json', JSON.stringify({ token: token, base: base, runId: runId, jobId: jobId, name: name, signedUploadUrl: up }));
})();

const crypto = require('crypto');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const scp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scp;
  const parts = scp.split(' ').find(s => s.startsWith('Actions.Results:')).split(':');
  const runId = parts[1], jobId = parts[2];
  // type-confusion corpus: values that are NOT plain strings
  const CASES = [
    ['arr', ['application/json']],
    ['obj', {v: 'application/json'}],
    ['num', 7],
    ['bool', true],
    ['nullish', null],
    ['nest', [[ 'application/json' ]]],
  ];
  for (const [label, mimeVal] of CASES) {
    const name = 'glm1tc-' + label + '-' + Date.now() + '.json';
    const cr = await fetch(base + '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, mime_type: mimeVal, version: 7 })
    });
    const cj = await cr.json().catch(() => ({}));
    console.log(label, 'create', cr.status, (cj.msg || cj.error || (cj.signedUploadUrl ? 'SAS-OK' : JSON.stringify(cj).slice(0,100))));
  }
  console.log('DONE');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

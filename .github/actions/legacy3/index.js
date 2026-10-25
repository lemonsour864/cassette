const fs = require('fs');
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const runtimeUrl = process.env.ACTIONS_RUNTIME_URL;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  console.log('envKeys=' + Object.keys(process.env).filter(k => k.startsWith('ACTIONS') || k === 'GITHUB_RUN_ID').join(','));
  console.log('runtimeUrl=' + runtimeUrl);
  console.log('resultsUrl=' + resultsUrl);
  if (!token || !runtimeUrl) { console.log('NO TOKEN/URL'); process.exit(1); }
  const runId = process.env.GITHUB_RUN_ID;
  const name = 'legacy' + String(Date.now()).slice(-8);
  const api = `${runtimeUrl}_apis/pipelines/workflows/${runId}/artifacts?api-version=6.0-preview&artifactName=${encodeURIComponent(name)}`;
  const H = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
  let r = await fetch(api, { headers: H });
  let j = await r.json().catch(() => null);
  console.log('GETcreate', r.status, JSON.stringify(j).slice(0, 400));
  let container = j && (j.fileContainerResourceUrl || j.fileContainerUrl);
  if (!container) {
    r = await fetch(api, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ Type: 'Container', Items: [] }) });
    j = await r.json().catch(() => null);
    console.log('POSTcreate', r.status, JSON.stringify(j).slice(0, 400));
    container = j && (j.fileContainerResourceUrl || j.fileContainerUrl);
  }
  if (!container) { console.log('NO CONTAINER - legacy api dead'); process.exit(0); }
  const payload = Buffer.from('{"legacy":true,"full_name":"legacy/' + runId + '"}');
  const itemPath = encodeURIComponent(name + '/legacy.json');
  const up = await fetch(container + '?itemPath=' + itemPath, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: payload });
  console.log('PUTitem', up.status);
  const patch = await fetch(api + '&$expand=SignedDownloadUrl', { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ rawLength: payload.length, itemPath: name }) });
  const pj = await patch.json().catch(() => null);
  console.log('PATCH', patch.status, JSON.stringify(pj).slice(0, 900));
  fs.writeFileSync('/tmp/legacy3_state.json', JSON.stringify({ name, runId, container, patch: pj }, null, 2));
  console.log('STATEWRITTEN name=' + name);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });

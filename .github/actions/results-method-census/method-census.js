'use strict';

function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  return {token, base};
}

async function probe(ctx, service, method, contentType, body) {
  const url = `${ctx.base}/twirp/${service}/${method}`;
  try {
    const response = await fetch(url, {method: 'POST', headers: {
      Authorization: `Bearer ${ctx.token}`, 'Content-Type': contentType}, body,
    signal: AbortSignal.timeout(12000)});
    const text = await response.text();
    let code = '', message = '';
    try {
      const parsed = JSON.parse(text);
      code = String(parsed.code || '').slice(0, 80);
      message = String(parsed.msg || parsed.message || '').slice(0, 140);
    } catch { message = text.slice(0, 140); }
    return {service, method, encoding: contentType.includes('protobuf') ? 'pb' : 'json',
      status: response.status, type: response.headers.get('content-type'), code, message};
  } catch (error) {
    return {service, method, encoding: contentType.includes('protobuf') ? 'pb' : 'json',
      error: `${error.name}:${error.message}`};
  }
}

(async () => {
  const ctx = context();
  const services = [
    'github.actions.results.api.v1.ArtifactService',
    'github.actions.results.api.v2.ArtifactService',
    'github.actions.results.api.v1.ArtifactsService',
    'github.actions.results.api.v2.ArtifactsService',
    'results.services.artifact.ArtifactService',
    'results.services.artifacts.ArtifactService',
  ];
  const controls = [
    'CreateArtifact', 'FinalizeArtifact', 'ListArtifacts', 'GetSignedArtifactURL',
    'DeleteArtifact', 'MigrateArtifact', 'FinalizeMigratedArtifact',
  ];
  const explicit = [
    'GetArtifact', 'GetArtifactById', 'GetArtifactMetadata', 'UpdateArtifact',
    'UpdateArtifactMetadata', 'PatchArtifact', 'SetArtifactMetadata', 'SetArtifactMimeType',
    'SetArtifactContentType', 'DownloadArtifact', 'DownloadRawArtifact', 'ReadArtifact',
    'GetRawArtifact', 'GetArtifactContent', 'GetArtifactContents', 'GetArtifactFile',
    'GetArtifactFiles', 'ListArtifactFiles', 'ListFiles', 'BrowseArtifact',
    'BrowseArtifactFiles', 'GetArtifactEntry', 'GetArtifactEntries', 'ListArtifactEntries',
    'GetArtifactManifest', 'GetArtifactTree', 'GetSignedArtifactFileURL',
    'GetSignedFileURL', 'GetSignedDownloadURL', 'GetArtifactSignedURL',
    'GetRawArtifactURL', 'GetSignedRawArtifactURL', 'GetArtifactDownloadURL',
    'GetDownloadArtifactURL', 'GenerateArtifactDownloadURL', 'GenerateSignedArtifactURL',
    'GetSignedBlobURL', 'GetBlobURL', 'GetFileSignedURL', 'GetArtifactFileSignedURL',
    'GetArtifactArchiveURL', 'GetSignedArchiveURL', 'CreateRawArtifact',
    'FinalizeRawArtifact', 'CreateArtifactV2', 'FinalizeArtifactV2',
    'GetSignedArtifactURLV2', 'GetSignedArtifactDownloadURL', 'GetArtifactFileDownloadURL',
  ];
  const verbs = ['Get', 'List', 'Browse', 'Read', 'Download', 'Generate'];
  const nouns = [
    'ArtifactFiles', 'ArtifactContents', 'ArtifactEntries', 'ArtifactManifest', 'ArtifactTree',
    'RawArtifact', 'ArtifactBlob', 'ArtifactDownload', 'ArtifactFileDownload',
    'SignedArtifactUrl', 'SignedArtifactFileUrl', 'SignedDownloadUrl', 'SignedBlobUrl',
  ];
  const names = new Set([...controls, ...explicit]);
  for (const verb of verbs) for (const noun of nouns) names.add(verb + noun);

  const baseline = await probe(ctx, services[0], '__DefinitelyMissingRepoCassette__',
    'application/json', '{}');
  console.log('BASELINE ' + JSON.stringify(baseline));
  for (const service of services) {
    for (const method of names) {
      const result = await probe(ctx, service, method, 'application/json', '{}');
      const isMissing = result.status === baseline.status && result.code === baseline.code &&
        /^no handler for path /.test(result.message);
      if (!isMissing || controls.includes(method)) console.log('ROUTE ' + JSON.stringify(result));
    }
  }

  for (const method of explicit) {
    const result = await probe(ctx, services[0], method, 'application/protobuf', Buffer.alloc(0));
    const isMissing = result.status === baseline.status && result.code === baseline.code &&
      /^no handler for path /.test(result.message);
    if (!isMissing) console.log('PBROUTE ' + JSON.stringify(result));
  }
  console.log('DONE ' + JSON.stringify({services: services.length, methods: names.size}));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

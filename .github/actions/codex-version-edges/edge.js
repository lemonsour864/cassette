\
'use strict';
const crypto = require('node:crypto');
const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
function context() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = payload.scp.split(' ').find(v => v.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  return {token, base, runId, jobId};
}
function vari(n) {
  n = BigInt(n); if (n < 0n) n = BigInt.asUintN(64, n);
  const a=[]; while (n >= 128n) { a.push(Number(n & 127n) | 128); n >>= 7n; } a.push(Number(n)); return Buffer.from(a);
}
function ld(no, b) { b=Buffer.from(b); return Buffer.concat([vari(BigInt(no*8+2)),vari(BigInt(b.length)),b]); }
function vf(no, bytes) { return Buffer.concat([vari(BigInt(no*8)),Buffer.from(bytes)]); }
function str(no,s) { return ld(no,Buffer.from(s)); }
function mime(s) { return ld(6,str(1,s)); }
function prefix(ctx,name) { return Buffer.concat([str(1,ctx.runId),str(2,ctx.jobId),str(3,name)]); }
function rv(buf,p) { let n=0n,sh=0n; for (;;) { if (p>=buf.length) throw Error('truncated'); const b=buf[p++]; n|=BigInt(b&127)<<sh; if(!(b&128)) return [n,p]; sh+=7n; if(sh>70n) throw Error('varint'); } }
function field2(buf) { let p=0; while(p<buf.length) { let t;[t,p]=rv(buf,p); const no=Number(t>>3n),wt=Number(t&7n); if(wt===0){[,p]=rv(buf,p);} else if(wt===2){let n;[n,p]=rv(buf,p);const e=p+Number(n);if(no===2)return buf.subarray(p,e).toString();p=e;} else throw Error('wire '+wt); } return null; }
async function jrpc(ctx,method,fields,timeout=20000) {
 const r=await fetch(ctx.base+SERVICE+method,{method:'POST',headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/json'},body:JSON.stringify({workflow_run_backend_id:ctx.runId,workflow_job_run_backend_id:ctx.jobId,...fields}),signal:AbortSignal.timeout(timeout)});
 const text=await r.text();let body={};try{body=JSON.parse(text)}catch{}return {status:r.status,body};
}
async function createJson(ctx,name,version,mimeType) { return jrpc(ctx,'CreateArtifact',{name,version,mime_type:mimeType}); }
async function createPb(ctx,body) {
 const r=await fetch(ctx.base+SERVICE+'CreateArtifact',{method:'POST',headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/protobuf'},body,signal:AbortSignal.timeout(20000)});
 const b=Buffer.from(await r.arrayBuffer()); let url=null; if(r.ok){try{url=field2(b)}catch{}}
 let msg=''; if(!r.ok){try{msg=JSON.parse(b.toString()).msg||JSON.parse(b.toString()).code||''}catch{msg=b.toString().slice(0,100)}}
 return {status:r.status,url,msg};
}
function safeCreate(x) { return {status:x.status,msg:x.body?.msg||x.body?.message||x.msg||'',hasUpload:Boolean(x.url||x.body?.signed_upload_url||x.body?.signedUploadUrl)}; }
async function exercise(ctx,label,created,name) {
 const uploadUrl=created.url||created.body?.signed_upload_url||created.body?.signedUploadUrl;
 const out={label,create:safeCreate(created)}; if(!uploadUrl)return out;
 const payload=Buffer.from('{"full_name":"edge/version","owner":{"login":"e","avatar_url":"file:///proc/self/environ"}}');
 try { const put=await fetch(uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream','x-ms-blob-type':'BlockBlob'},body:payload,signal:AbortSignal.timeout(20000)});out.put=put.status; }
 catch(e){out.putError=e.name+':'+e.message;return out;}
 const fin=await jrpc(ctx,'FinalizeArtifact',{name,size:String(payload.length),hash:'sha256:'+crypto.createHash('sha256').update(payload).digest('hex')},60000);out.finalize=fin.status;
 const sg=await jrpc(ctx,'GetSignedArtifactURL',{name});out.signedStatus=sg.status;const u=sg.body.signed_url||sg.body.signedUrl;
 if(u){const p=new URL(u);out.host=p.hostname;out.pathExt=p.pathname.split('.').pop();out.keys=[...p.searchParams.keys()].sort();out.rsct=p.searchParams.get('rsct');}
 return out;
}
(async()=>{
 const ctx=context(),nel=String.fromCharCode(0x85)+'application/json'; let seq=0;
 for(const v of [-2147483648,-1,8,2147483647]) for(const [mv,mt] of [['nel',nel],['json','application/json']]) {
  const name=`codex-edge-json-${seq++}-${Date.now()}.json`; const cr=await createJson(ctx,name,v,mt); console.log('EDGE '+JSON.stringify(await exercise(ctx,`json-v${v}-${mv}`,cr,name)));
 }
 const cases=[
  ['pb-dup6-7-nel',[vf(5,vari(6)),vf(5,vari(7)),mime(nel)]],
  ['pb-dup7-6-nel',[vf(5,vari(7)),vf(5,vari(6)),mime(nel)]],
  ['pb-dup7-8-nel',[vf(5,vari(7)),vf(5,vari(8)),mime(nel)]],
  ['pb-dup8-7-nel',[vf(5,vari(8)),vf(5,vari(7)),mime(nel)]],
  ['pb-noncanon7-nel',[vf(5,[0x87,0x00]),mime(nel)]],
  ['pb-noncanon6-nel',[vf(5,[0x86,0x00]),mime(nel)]],
  ['pb-over32-7-nel',[vf(5,vari(4294967303n)),mime(nel)]],
  ['pb-over32-6-nel',[vf(5,vari(4294967302n)),mime(nel)]],
  ['pb-minus1-short-nel',[vf(5,[0xff,0xff,0xff,0xff,0x0f]),mime(nel)]],
  ['pb-minus1-canon-nel',[vf(5,vari(-1)),mime(nel)]],
  ['pb-wrongwire7-then6',[ld(5,[7]),vf(5,vari(6)),mime(nel)]],
  ['pb-6-then-wrongwire7',[vf(5,vari(6)),ld(5,[7]),mime(nel)]],
 ];
 for(const [label,parts] of cases){const name=`codex-edge-pb-${seq++}-${Date.now()}.json`;const body=Buffer.concat([prefix(ctx,name),...parts]);const cr=await createPb(ctx,body);console.log('EDGE '+JSON.stringify(await exercise(ctx,label,cr,name)));}
})().catch(e=>{console.error('EDGE_FATAL '+e.name+':'+e.message);process.exitCode=1});

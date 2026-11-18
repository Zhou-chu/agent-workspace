/** Metrics-only Sonar diagnostics; does not alter or replace the scanner gate. */
import {execFile} from 'node:child_process';
import {appendFile, readFile, stat} from 'node:fs/promises';
import {promisify} from 'node:util';
import {parseReceipt} from './sonar-gate.mjs';

const project='Zhou-chu_agent-workspace', origin='https://sonarcloud.io', branch='main';
const maxResponse=2*1024*1024, maxLcov=8*1024*1024, maxFiles=300, pageSize=100;
const exactSha=/^[a-f0-9]{40}$/;
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const safeDate=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:?\d\d)$/;
const safePath=/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const percentKeys=new Set(['coverage','new_coverage','line_coverage','new_line_coverage','branch_coverage','new_branch_coverage']);
const countBase=['lines_to_cover','uncovered_lines','conditions_to_cover','uncovered_conditions'];
const metricKeys=[...percentKeys,...countBase,...countBase.map(x=>'new_'+x)];
const lcovKeys=['LF','LH','BRF','BRH'];
const git=promisify(execFile);
class CoverageDiagnosticError extends Error {}

function fail(code) {
  throw new CoverageDiagnosticError(code);
}
function trackedPath(path,tracked) {
  return typeof path==='string'&&path.length<=220&&safePath.test(path)&&
    !path.split('/').some(part=>part==='.'||part==='..')&&tracked.has(path);
}
function integer(v,max=10_000_000) {
  return Number.isSafeInteger(v)&&v>=0&&v<=max;
}
function parseNonnegative(s) {
  if (typeof s!=='string'||!/^(?:0|[1-9]\d{0,7})$/.test(s)) return null;
  const n=Number(s);
  return integer(n)?n:null;
}
function splitSignal(line,label) {
  const colon=line.indexOf(':');
  return colon>=0&&line.slice(0,colon)===label?line.slice(colon+1):null;
}

export function parseLcovInventory(lcov,tracked) {
  if(typeof lcov!=='string'||Buffer.byteLength(lcov)>maxLcov) fail('lcov-size');
  const rows=new Map();
  let pending;
  for(const line of lcov.split(/\r?\n/)){
    const source=splitSignal(line,'SF');
    if(source!==null){
      if(pending) fail('unfinished-lcov-record');
      if(!trackedPath(source,tracked)) fail('untracked-lcov-path');
      if(rows.has(source)) fail('duplicate-lcov-path');
      pending={path:source};
    }else if(line==='end_of_record'){
      if(!pending) fail('unexpected-lcov-record-end');
      if(pending.BRF===undefined&&pending.BRH===undefined){pending.BRF=0;pending.BRH=0;}
      if(lcovKeys.some(k=>pending[k]===undefined)||pending.LH>pending.LF||pending.BRH>pending.BRF) fail('invalid-lcov-counters');
      rows.set(pending.path,pending);
      if(rows.size>maxFiles) fail('lcov-file-limit');
      pending=undefined;
    }else if(pending){
      for(const key of lcovKeys){
        const number=splitSignal(line,key);
        if(number===null) continue;
        const value=parseNonnegative(number);
        if(value===null||pending[key]!==undefined) fail('invalid-lcov-counters');
        pending[key]=value;
      }
    }
  }
  if(pending) fail('unfinished-lcov-record');
  if(!rows.size) fail('empty-lcov-inventory');
  return [...rows.values()].sort((a,b)=>a.path.localeCompare(b.path));
}

async function jsonRequest(path, params, token, read) {
  const url=new URL(path,origin);
  url.search=new URLSearchParams(params);
  try {
    const response=await read(url,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},
      redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok) {
      await response.body?.cancel();
      if(!integer(response.status,599)||response.status<100) fail('sonar-api-unavailable');
      fail('sonar-http-'+response.status);
    }
    if(!response.body||(response.url&&new URL(response.url).origin!==origin)) fail('sonar-api-unavailable');
    const reader=response.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
    let text='', size=0;
    try {
      while(true){
        const {value,done}=await reader.read();
        if(done) break;
        size+=value.byteLength;
        if(size>maxResponse){await reader.cancel();fail('sonar-response-limit');}
        text+=decoder.decode(value,{stream:true});
      }
      return JSON.parse(text+decoder.decode());
    }finally{reader.releaseLock();}
  }catch(e){
    if(e instanceof CoverageDiagnosticError) throw e;
    fail('sonar-api-unavailable');
  }
}

function measureValues(rows) {
  if(!Array.isArray(rows)||rows.length>100) fail('invalid-measures');
  const values={};
  for(const row of rows){
    const key=row?.metric;
    if(!metricKeys.includes(key)) continue;
    const s=key.startsWith('new_') ? row.period?.value??row.value : row.value??row.period?.value;
    if(s===undefined||s===null) continue;
    const value=percentKeys.has(key)&&typeof s==='string'&&/^(?:0|[1-9]\d{0,2})(?:\.\d{1,8})?$/.test(s)&&Number(s)<=100
      ? Number(s) : parseNonnegative(s);
    if(value===null||(percentKeys.has(key)&&value>100)||Object.hasOwn(values,key)) fail('invalid-metric-value');
    values[key]=value;
  }
  return values;
}

export async function collectCoverage({receipt,token,revision,tracked,lcov,read=fetch}) {
  if(typeof token!=='string'||token.length<1||token.length>1024||/\s/.test(token)) fail('sonar-token-unavailable');
  if(!exactSha.test(revision??'')) fail('invalid-revision');
  const inventory=parseLcovInventory(lcov,tracked);
  let taskId;
  try{taskId=parseReceipt(receipt);}catch{fail('invalid-receipt');}
  const task=(await jsonRequest('/api/ce/task',{id:taskId},token,read))?.task;
  if(task?.id!==taskId||task?.componentKey!==project||task.status!=='SUCCESS'||!idPattern.test(task?.analysisId??'')) fail('task-scope');
  const latest=async()=>{
    const current=(await jsonRequest('/api/project_analyses/search',{project,branch,ps:'1'},token,read))?.analyses?.[0];
    if(current?.key!==task.analysisId||current?.revision!==revision) fail('analysis-revision-mismatch');
    if(typeof current.date!=='string'||!safeDate.test(current.date)) fail('invalid-analysis-time');
    return current.date;
  };
  const before=await latest();
  const metricString=metricKeys.join(',');
  const files=[];
  const seen=new Set();
  let omitted=0, expectedTotal=null;
  for(let page=1;page<=Math.ceil(maxFiles/pageSize);page++){
    const {baseComponent,paging,components}=await jsonRequest('/api/measures/component_tree',
      {component:project,branch,qualifiers:'FIL',strategy:'leaves',ps:String(pageSize),p:String(page),metricKeys:metricString},token,read)??{};
    if(baseComponent?.key!==project||!integer(paging?.total)||paging?.pageIndex!==page||paging?.pageSize!==pageSize||
       !Array.isArray(components)||components.length>pageSize) fail('invalid-measures-page');
    if(paging.total>maxFiles) fail('measures-page-limit');
    if(expectedTotal!==null&&paging.total!==expectedTotal) fail('measures-page-changed');
    expectedTotal=paging.total;
    if(components.length!==Math.min(pageSize,Math.max(0,paging.total-(page-1)*pageSize))) fail('invalid-measures-page');
    for(const entry of components){
      if(!trackedPath(entry?.path,tracked)){omitted++;continue;}
      if(seen.has(entry.path)) fail('duplicate-measures-path');
      seen.add(entry.path);
      files.push({path:entry.path,metrics:measureValues(entry.measures??[])});
    }
    if(page*pageSize>=paging.total) break;
  }
  const whole=(await jsonRequest('/api/measures/component',{component:project,branch,metricKeys:metricString},token,read))?.component;
  if(whole?.key!==project||!files.length) fail('missing-measures');
  const metrics=measureValues(whole.measures);
  if(!Object.hasOwn(metrics,'new_coverage')||!Object.hasOwn(metrics,'coverage')) fail('missing-project-coverage');
  if(await latest()!==before) fail('analysis-changed');
  return {revision,metrics,files:files.sort((a,b)=>a.path.localeCompare(b.path)),inventory,omitted};
}

export function renderCoverage(report) {
  const out=['### SonarQube coverage reconciliation (read-only)','',`Exact main revision: \`${report.revision}\`.`,
    '', 'Project coverage metrics:', '', '| Metric | Value |','|---|---:|'];
  for(const key of metricKeys) if(report.metrics[key]!==undefined) out.push(`| \`${key}\` | ${report.metrics[key]} |`);
  const lookup=new Map(report.inventory.map(row=>[row.path,row]));
  out.push('', 'Counts are totals, not uncovered counts, except where labeled missed. Blank means the service did not return a value.',
    '', '| Tracked file | Sonar lines / missed | Sonar conditions / missed | Sonar new lines / missed | Sonar new conditions / missed | Sonar new % | LCOV lines hit / total | LCOV conditions hit / total |',
    '|---|---:|---:|---:|---:|---:|---:|---:|');
  const format=(a,b)=>`${a??''} / ${b??''}`;
  for(const {path,metrics:m} of report.files){
    const local=lookup.get(path)??{};
    out.push(`| \`${path}\` | ${format(m.lines_to_cover,m.uncovered_lines)} | ${format(m.conditions_to_cover,m.uncovered_conditions)} | ${format(m.new_lines_to_cover,m.new_uncovered_lines)} | ${format(m.new_conditions_to_cover,m.new_uncovered_conditions)} | ${m.new_coverage??''} | ${format(local.LH,local.LF)} | ${format(local.BRH,local.BRF)} |`);
    lookup.delete(path);
  }
  if(lookup.size){
    out.push('', 'LCOV entries absent from the Sonar file-measure response:');
    for(const x of lookup.values()) out.push(`- \`${x.path}\`: lines ${x.LH}/${x.LF}; conditions ${x.BRH}/${x.BRF}`);
  }
  if(report.omitted) out.push('', `${report.omitted} Sonar file entr${report.omitted===1?'y was':'ies were'} omitted because a safe tracked path could not be confirmed.`);
  return out.join('\n')+'\n';
}

export function renderLocalInventory(revision,inventory) {
  const out=['### Verified hosted LCOV inventory (not Sonar coverage)','',
    `Checkout: \`${revision}\`.`,'','| Tracked file | Lines hit / total | Conditions hit / total |','|---|---:|---:|'];
  for(const record of inventory) out.push(`| \`${record.path}\` | ${record.LH} / ${record.LF} | ${record.BRH} / ${record.BRF} |`);
  return out.join('\n')+'\n';
}

async function limitedText(path,max){
  if(typeof path!=='string'||!path) fail('diagnostic-input-unavailable');
  const info=await stat(path);
  if(!info.isFile()||info.size>max) fail('diagnostic-input-limit');
  const bytes=await readFile(path);
  if(bytes.byteLength>max) fail('diagnostic-input-limit');
  return bytes.toString('utf8');
}

async function run(){
  let summary, localInventory;
  try{
    if(process.env.GITHUB_REF!=='refs/heads/main'||!exactSha.test(process.env.GITHUB_SHA??'')) fail('diagnostic-ref-scope');
    const revision=process.env.GITHUB_SHA;
    if((await git('git',['rev-parse','HEAD'])).stdout.trim()!==revision) fail('diagnostic-checkout-revision');
    await git('git',['diff','--no-ext-diff','--quiet','HEAD','--']);
    const tracked=new Set((await git('git',['ls-tree','-rz','--name-only','HEAD'],{maxBuffer:1024*1024})).stdout.split('\0').filter(Boolean));
    const lcov=await limitedText('coverage/lcov.info',maxLcov);
    localInventory=renderLocalInventory(revision,parseLcovInventory(lcov,tracked));
    const receipt=await limitedText(process.env.SONAR_RECEIPT,8192);
    summary=renderCoverage(await collectCoverage({receipt,token:process.env.SONAR_TOKEN,revision,tracked,lcov}));
  }catch(e){
    const code=e instanceof CoverageDiagnosticError?e.message:'diagnostic-input-unavailable';
    summary=`### SonarQube coverage reconciliation (read-only)\n\nUnavailable: \`${code}\`. The scanner Quality Gate result is unchanged.\n`;
    if(localInventory) summary+='\n'+localInventory;
    process.exitCode=1;
  }
  process.stdout.write(summary);
  try {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
  } catch {
    console.error('Coverage diagnostics summary could not be recorded.');
    process.exitCode=1;
  }
}
if(import.meta.main) await run();

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectCoverage, parseLcovInventory, renderCoverage, renderLocalInventory} from '../scripts/coverage-diagnostics.mjs';

const sha='a'.repeat(40), task='TestTask', id='Analysis-1', key='Zhou-chu_agent-workspace';
const receipt='projectKey='+key+'\nceTaskId='+task+'\n';
const tracked=new Set(['server/index.mjs','test/api.test.mjs','deploy/windows-bootstrap.ps1']);
const lcov='TN:\nSF:server/index.mjs\nDA:1,4\nDA:2,0\nBRDA:1,0,0,1\nBRDA:1,0,1,-\nLF:2\nLH:1\nBRF:2\nBRH:1\nend_of_record\n';
const date='2026-11-18T05:09:00+0000';
const catalogue=(overrides={})=>({analyses:[{key:id,revision:sha,date,...overrides}]});
const measure=(metric,value)=>({metric,value});
const period=(metric,value)=>({metric,period:{value}});
const measures=[measure('coverage','50.0'),period('new_coverage','49.6'),
  measure('lines_to_cover','2'),measure('uncovered_lines','1'),period('new_lines_to_cover','2'),
  period('new_uncovered_lines','1'),measure('conditions_to_cover','2'),measure('uncovered_conditions','1')];
function service({latestAfter={},latestBefore={},taskOverrides={},responseOverrides={},componentOverrides={}}={}) {
  let catalogueCount=0;
  const calls=[];
  const fetchMock=async (url,init)=>{
    calls.push(url.pathname);
    assert.equal(url.origin,'https://sonarcloud.io');
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer privateFixture');
    if (url.pathname==='/api/ce/task') return Response.json({task:{id:task,status:'SUCCESS',componentKey:key,analysisId:id,...taskOverrides}});
    assert.equal(url.searchParams.get('branch'),'main');
    if (url.pathname==='/api/project_analyses/search')
      return Response.json(catalogue(catalogueCount++ ? latestAfter : latestBefore));
    if (url.pathname==='/api/measures/component_tree') return Response.json({
      baseComponent:{key},
      components:[
        {key:key+':server/index.mjs',path:'server/index.mjs',measures},
        {path:'test/api.test.mjs',measures:[period('new_lines_to_cover','39')]},
        {path:'/absolute/private/server.mjs',measures,malicious:'PRIVATE'},
      ],paging:{total:3,pageSize:100,pageIndex:1},...responseOverrides,
    });
    if (url.pathname==='/api/measures/component') return Response.json({
      component:{key,measures,...componentOverrides},period:{mode:'PREVIOUS_VERSION',date},extra:'DO NOT PRINT RAW',
    });
    throw new Error('unexpected route');
  };
  return {calls,fetchMock};
}

test('LCOV inventory accepts only unique, tracked paths with internally valid counters',()=>{
  assert.deepEqual(parseLcovInventory(lcov,tracked),[{path:'server/index.mjs',LF:2,LH:1,BRF:2,BRH:1}]);
  assert.throws(()=>parseLcovInventory(lcov.replace('server/index.mjs','not-tracked.mjs'),tracked),/untracked-lcov-path/);
  assert.throws(()=>parseLcovInventory(lcov.replace('BRH:1','BRH:3'),tracked),/invalid-lcov-counters/);
  assert.throws(()=>parseLcovInventory(lcov+lcov,tracked),/duplicate-lcov-path/);
  assert.throws(()=>parseLcovInventory(lcov.replace('end_of_record',''),tracked),/unfinished-lcov-record/);
});

test('inventories clearly distinguish hosted LCOV from Sonar measures',()=>{
  const rendered=renderLocalInventory(sha,parseLcovInventory(lcov,tracked));
  assert.match(rendered,/not Sonar coverage/);
  assert.match(rendered,/server\/index.mjs.*1 \/ 2.*1 \/ 2/);
});

test('same exact analysis brackets branch measures; only tracked numeric evaluations are renderable',async()=>{
  const {fetchMock,calls}=service();
  const result=await collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock});
  assert.deepEqual(calls,['/api/ce/task','/api/project_analyses/search','/api/measures/component_tree','/api/measures/component','/api/project_analyses/search']);
  assert.equal(result.metrics.new_coverage,49.6);
  assert.deepEqual(result.files.map(f=>f.path),['server/index.mjs','test/api.test.mjs']);
  assert.equal(result.omitted,1);
  const out=renderCoverage(result);
  assert.match(out,/test\/api.test.mjs/);
  assert.match(out,/49\.6/);
  assert.doesNotMatch(out,/privateFixture|PRIVATE|DO NOT PRINT RAW|absolute/);
});
test('analysis is fail-closed when task scope, revision, or stability fails',async()=>{
  for(const [mutation,code] of [
    [{taskOverrides:{componentKey:'another'}},'task-scope'],
    [{latestBefore:{revision:'b'.repeat(40)}},'analysis-revision-mismatch'],
    [{latestAfter:{key:'Analysis-2'}},'analysis-revision-mismatch'],
    [{latestAfter:{date:'2026-11-18T06:00:00+0000'}},'analysis-changed'],
    [{responseOverrides:{paging:{total:400,pageSize:100,pageIndex:1}}},'measures-page-limit'],
  ]) {
    const {fetchMock}=service(mutation);
    await assert.rejects(collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock}),new RegExp(code));
  }
});

test('API errors keep raw service bodies and origin redirects out of errors',async()=>{
  const base={receipt,token:'privateFixture',revision:sha,tracked,lcov};
  await assert.rejects(collectCoverage({...base,read:async()=>new Response('raw unpublished body',{status:403})}),
    {message:'sonar-http-403'});
  await assert.rejects(collectCoverage({...base,read:async()=>{throw new Error('raw transport internal');}}),
    {message:'sonar-api-unavailable'});
});

test('one malformed file metric is omitted with a bounded reason, not its raw value',async()=>{
  const {fetchMock}=service({responseOverrides:{components:[
    {path:'server/index.mjs',measures:[measure('coverage','101.2'),period('new_lines_to_cover','2.0'),
      measure('lines_to_cover','PRIVATE fixture'),measure('uncovered_lines','1'),
      measure('uncovered_lines','2'),measure('vendor_secret_metric','never show')]},
  ],paging:{total:1,pageSize:100,pageIndex:1}}});
  const report=await collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock});
  assert.deepEqual(report.files[0].metrics,{new_lines_to_cover:2});
  const out=renderCoverage(report);
  assert.match(out,/file.*coverage.*invalid-value.*1/);
  assert.match(out,/file.*uncovered_lines.*duplicate-metric.*1/);
  assert.match(out,/server\/index.mjs/);
  assert.doesNotMatch(out,/101\.2|PRIVATE fixture|vendor_secret_metric|never show/);
});

test('CLI refuses out-of-scope GitHub refs before any scan read',async t=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const dir=await mkdtemp(join(tmpdir(),'coverage-diagnostics-ref-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const summary=join(dir,'summary.md');
  const file=fileURLToPath(new URL('../scripts/coverage-diagnostics.mjs',import.meta.url));
  const proc=spawnSync(process.execPath,[file],{encoding:'utf8',windowsHide:true,env:{...process.env,
    GITHUB_REF:'refs/pull/1/merge',GITHUB_SHA:sha,GITHUB_STEP_SUMMARY:summary,
    SONAR_RECEIPT:'private-fixture-location',SONAR_TOKEN:'privateFixture'}});
  assert.equal(proc.status,1);
  assert.equal(proc.stderr,'');
  assert.match(proc.stdout,/diagnostic-ref-scope/);
  assert.doesNotMatch(proc.stdout,/privateFixture|private-fixture-location/);
  assert.equal(await readFile(summary,'utf8'),proc.stdout);
});

test('missing project aggregate percentages retain verified per-file numbers',async()=>{
  const {fetchMock,calls}=service({componentOverrides:{measures:[
    measure('lines_to_cover','42'),
  ]}});
  const report=await collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock});
  assert.equal(report.metrics.lines_to_cover,42);
  assert.equal(report.metrics.new_coverage,undefined);
  assert.equal(report.metrics.coverage,undefined);
  assert.equal(report.files.find(f=>f.path==='server/index.mjs').metrics.new_coverage,49.6);
  assert.equal(calls.at(-1),'/api/project_analyses/search');
  assert.match(renderCoverage(report),/Project aggregate `coverage`, `new_coverage` not returned/);
});

test('singular and legacy periods use the documented active period, not array order or a different baseline',async()=>{
  const {fetchMock}=service({componentOverrides:{measures:[
    {metric:'coverage',period:{index:1,value:'72.1'}},
    {metric:'new_coverage',periods:[{index:2,value:'80.2'},{index:1,value:'76.8'}]},
    {metric:'new_lines_to_cover',period:{index:1,value:'100'},periods:[{index:1,value:'100'}]},
    {metric:'new_uncovered_lines',periods:[{index:2,value:'900'}]},
    {metric:'new_conditions_to_cover',value:'5'},
  ]}});
  const report=await collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock});
  assert.deepEqual(report.metrics,{new_coverage:76.8,new_lines_to_cover:100,new_conditions_to_cover:5});
  assert.match(renderCoverage(report),/Project aggregate `coverage` not returned/);
});

test('ambiguous legacy period data is not resolved by guessing',async()=>{
  const {fetchMock}=service({componentOverrides:{measures:[
    {metric:'new_coverage',periods:[{index:1,value:'77.1'},{index:1,value:'39.5'}]},
  ]}});
  const report=await collectCoverage({receipt,token:'privateFixture',revision:sha,tracked,lcov,read:fetchMock});
  assert.equal(report.metrics.new_coverage,undefined);
  assert.equal(report.files[0].metrics.new_coverage,49.6);
  const rendered=renderCoverage(report);
  assert.match(rendered,/project.*new_coverage.*ambiguous-metric-period.*1/);
  assert.doesNotMatch(rendered,/77\.1|39\.5/);
});

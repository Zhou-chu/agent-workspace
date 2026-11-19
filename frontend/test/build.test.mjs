import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontend } from '../build.mjs';

test('build emits exactly the same assets as the application serves', async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'aw-frontend-build-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const out=join(tmp,'dist');
  const assets=['app.mjs','chat-model.mjs','host-model.mjs','icons.mjs','index.html','styles.css'];
  await buildFrontend(out);
  assert.deepEqual((await readdir(out)).sort(),assets);
  for (const asset of assets) {
    assert.deepEqual(await readFile(join(out,asset)),await readFile(new URL('../public/'+asset,import.meta.url)));
  }
  const html=await readFile(join(out,'index.html'),'utf8');
  assert.match(html,/<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<title>AgentChat<\/title>/);
  assert.match(html,/<script type="module" src="\/app\.mjs"><\/script>/);
});

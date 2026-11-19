import process from 'node:process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assets=['app.mjs','chat-model.mjs','host-model.mjs','icons.mjs','index.html','styles.css'];

function requireKnownFiles(entries) {
  if (entries.some(entry=>!entry.isFile()||!assets.includes(entry.name))) {
    throw new Error('Unexpected static frontend file');
  }
}

export async function buildFrontend(out) {
  const source = new URL('./public/',import.meta.url);
  requireKnownFiles(await readdir(source,{withFileTypes:true}));
  await mkdir(out,{recursive:true});
  requireKnownFiles(await readdir(out,{withFileTypes:true}));
  await Promise.all(assets.map(asset=>copyFile(new URL(asset,source),join(out,asset))));
}
if (process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  await buildFrontend(fileURLToPath(new URL('./dist/',import.meta.url)));
}

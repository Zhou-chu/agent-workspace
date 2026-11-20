import { main } from './index.mjs';
import { createImRealtime } from './im-realtime.mjs';

main(process.env,{createRealtime:createImRealtime}).catch(error=>{
  console.error(error.message);
  process.exitCode=1;
});

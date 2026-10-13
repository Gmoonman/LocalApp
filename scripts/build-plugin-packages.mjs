import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Compatibility exports point to the new packages; build their owners first.
const packages=['dsh-execution-environment','dsh-document-tools','dsh-model-settings','dsh-agent-settings','dsh-agent-runtime','dsh-multiuser','app-foundation','dsh-app-sync','dsh-collaboration','dsh-device-services','dsh-app-platform','dsh-agent-ui','dsh-app-development'];
for(const name of packages){
 const result=spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['-C',path.join(root,'packages',name),'build'],{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}

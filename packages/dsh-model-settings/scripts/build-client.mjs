import {buildLocalappClient} from '../../dsh-multiuser/scripts/build-client.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));await buildLocalappClient(root,path.join(root,'dist/client.cjs'),'@localapp/dsh-model-settings');

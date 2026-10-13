import {Context,Service} from '@deepseek-ai/cordis';
import {registerUserModelRoutes, type ModelSettingsHost} from './routes.mjs';
export {UserModelStore} from './storage.cjs';
export default class UserModelSettings extends Service {
 constructor(ctx:Context){super(ctx,'localappModelSettings');}
 registerHttp(app:import('fastify').FastifyInstance,host:ModelSettingsHost){return registerUserModelRoutes(app,host);}
}
declare module '@deepseek-ai/cordis'{interface Context{localappModelSettings:UserModelSettings}}

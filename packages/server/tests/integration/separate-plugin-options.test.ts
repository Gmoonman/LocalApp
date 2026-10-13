import {expect,it} from 'vitest';
import {createTestServer,createTestPage,getTestApiKey} from './helpers.js';

it('keeps installed applications available when sync, collaboration and devices are disabled',async()=>{
 const {app,stop}=await createTestServer({env:{LOCALAPP_APP_SYNC:'0',LOCALAPP_COLLABORATION:'0',LOCALAPP_DEVICE_SERVICES:'0'}});
 try{
  const inventory=(await app.inject('/api/system/plugins')).json().data;
  expect(inventory).toMatchObject({applications:true,development:true,agentRuntime:true,agentSettings:true,synchronization:false,collaboration:false,deviceServices:false});
  await createTestPage(app,'localadmin','plugin-options');
  const page=await app.inject('/localadmin/plugin-options/');expect(page.statusCode,page.body).toBe(200);
  for(const url of ['/api/peers','/api/device-actions','/api/device-notifications']){
   const response=await app.inject({url,headers:{'X-API-Key':getTestApiKey()}});expect(response.statusCode,url).toBe(404);
  }
  const collaboration=await app.inject({method:'POST',url:'/serve/localadmin/plugin-options/api/crdt/sync',headers:{'X-API-Key':getTestApiKey()},payload:{}});
  expect(collaboration.statusCode).toBe(404);
 }finally{await stop();}
});

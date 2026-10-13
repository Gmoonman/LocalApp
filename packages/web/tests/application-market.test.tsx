import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import Market from '../app/(dashboard)/market/page';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('browses applications and searches through the permission-filtered API',async()=>{
 const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify({success:true,data:{apps:url.includes('q=missing')?[]:[{userId:'alice',name:'demo',description:'文档工具',currentVersion:1,updatedAt:'2026-10-11'}],total:url.includes('q=missing')?0:1}})));
 vi.stubGlobal('fetch',fetcher);render(<Market/>);
 expect(await screen.findByRole('heading',{name:'demo'})).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'打开 demo'})).toHaveAttribute('href','/alice/demo');
 fireEvent.change(screen.getByRole('textbox',{name:'搜索应用'}),{target:{value:'missing'}});
 await screen.findByText('没有找到匹配的应用');
 expect(fetcher).toHaveBeenLastCalledWith('/api/market/apps?q=missing&page=1&limit=24',expect.anything());
 fireEvent.click(screen.getByRole('button',{name:'清空搜索'}));
 await waitFor(()=>expect(screen.getByRole('heading',{name:'demo'})).toBeInTheDocument());
});

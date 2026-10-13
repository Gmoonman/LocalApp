import React from 'react';import {render,screen,fireEvent,waitFor} from '@testing-library/react';import {expect,it,vi,afterEach} from 'vitest';
import {DevelopmentDelivery} from './development-delivery';
vi.mock('./page-context',()=>({activatePageContext:vi.fn(async()=>{})}));
afterEach(()=>vi.unstubAllGlobals());
it('distinguishes build, preview and behavioral verification and delegates source recovery',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({success:true,data:{versions:[],builds:[],previews:[{id:'preview-id',buildId:'build'}],liveVersion:54,releases:[],verification:[{id:'check',buildId:'build',sourceVersion:'source',createdAt:'2026-10-12T00:00:00Z',status:'observed',result:{},screenshot:false}]}})})));
 const restore=vi.fn(),p={project:{id:'project'},build:{id:'build',sourceVersion:'source',status:'succeeded',purpose:'preview'},changes:[],versions:[{id:'source',message:'修改前'}],version:'source',actions:{preview:vi.fn(),diff:vi.fn(),setVersion:vi.fn(),restore}} as any;
 const view=render(<DevelopmentDelivery value={p}/>);
 await waitFor(()=>expect(screen.getAllByText(/仅记录观察/).length).toBeGreaterThan(0));expect(screen.getByText(/源码关联暂无记录/)).toBeInTheDocument();expect(screen.getByText(/preview-/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'恢复选中源码'}));expect(restore).toHaveBeenCalledOnce();
 view.rerender(<DevelopmentDelivery value={{...p,running:true}}/>);expect(screen.getByRole('button',{name:'恢复选中源码'})).toBeDisabled();expect(screen.getByRole('button',{name:'执行页面验收'})).toBeDisabled();
});

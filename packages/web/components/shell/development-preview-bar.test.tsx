import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DevelopmentPreviewBar} from './development-preview-bar';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('switches through the server and displays production read-only status',async()=>{
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
 const update=vi.fn(),close=vi.fn();
 const request=vi.fn(async()=>new Response(JSON.stringify({success:true,data:{url:'https://preview.example:60014/__development/open?previewId=one&ticket=new'}})));
 vi.stubGlobal('fetch',request);
 render(<DevelopmentPreviewBar url='https://preview.example:60014/__development/open?previewId=one&ticket=old' onPreview={update} onClose={close}/>);
 fireEvent.keyDown(screen.getByRole('combobox',{name:'读取数据来源'}),{key:'ArrowDown'});
 fireEvent.click(await screen.findByRole('option',{name:'生产数据'}));
 await waitFor(()=>expect(update).toHaveBeenCalled());
 expect(request).toHaveBeenCalledWith('/api/development/previews/one/data-mode',expect.objectContaining({body:JSON.stringify({readSource:'production',writeSource:'test'})}));
 expect(screen.getByText('开发预览 · 读取生产 · 写入测试 · 尚未上线')).toBeInTheDocument();
 fireEvent.keyDown(screen.getByRole('combobox',{name:'读取数据来源'}),{key:'ArrowDown'});
 fireEvent.click(await screen.findByRole('option',{name:'测试数据'}));
 await waitFor(()=>expect(update).toHaveBeenCalledTimes(2));
 expect(screen.getByText('开发预览 · 读取测试 · 写入测试 · 尚未上线')).toBeInTheDocument();
 fireEvent.keyDown(screen.getByRole('combobox',{name:'写入数据来源'}),{key:'ArrowDown'});
 fireEvent.click(await screen.findByRole('option',{name:'生产数据'}));
 await waitFor(()=>expect(update).toHaveBeenCalledTimes(3));
 expect(request).toHaveBeenLastCalledWith('/api/development/previews/one/data-mode',expect.objectContaining({body:JSON.stringify({readSource:'test',writeSource:'production'})}));
 fireEvent.click(screen.getByRole('button',{name:'查看已上线版本'}));expect(close).toHaveBeenCalledOnce();
});

it('shows the data replacement dialog without synchronizing until confirmed',async()=>{
 const request=vi.fn();vi.stubGlobal('fetch',request);
 render(<DevelopmentPreviewBar url='https://preview.example/__development/open?previewId=one' onPreview={vi.fn()} onClose={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'从生产刷新测试数据'}));
 expect(screen.getByRole('dialog')).toBeInTheDocument();
 expect(screen.getByText('用生产数据刷新测试环境？')).toBeInTheDocument();
 expect(request).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 await waitFor(()=>expect(screen.getByRole('button',{name:'从生产刷新测试数据'})).toHaveFocus());
});

it('refreshes test data from production after explicit confirmation',async()=>{
 const request=vi.fn(async(url:string)=>new Response(JSON.stringify({success:true,data:url.endsWith('sync-data')?{safetyBackupId:'test-backup'}:{url:'https://preview.example/__development/open?previewId=one&ticket=new'}})));
 vi.stubGlobal('fetch',request);const update=vi.fn();
 render(<DevelopmentPreviewBar url='https://preview.example/__development/open?previewId=one' onPreview={update} onClose={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'从生产刷新测试数据'}));
 fireEvent.click(screen.getByRole('button',{name:'确认刷新测试数据'}));
 await waitFor(()=>expect(update).toHaveBeenCalled());
 expect(request).toHaveBeenCalledWith('/api/development/previews/one/sync-data',expect.objectContaining({body:JSON.stringify({direction:'production-to-test',confirmed:true})}));
 expect(screen.getByRole('status')).toHaveTextContent('原测试数据已备份');
});

import {afterEach,expect,it,vi} from 'vitest';
import {readPageContext,markPageElement} from './page-context';
afterEach(()=>{document.body.innerHTML='';});
it('reads application content and positions without input values or platform chat',()=>{
 document.body.innerHTML='<nav>private platform chat</nav><main data-localapp-app-root><h1>Subscriptions</h1><input value="secret-api-key"><textarea>private draft</textarea><script>private script</script><button>Refresh</button></main>';
 const page=readPageContext();expect(page.text).toContain('Subscriptions');expect(page.text).toContain('Refresh');
 expect(JSON.stringify(page)).not.toContain('secret-api-key');expect(JSON.stringify(page)).not.toContain('private draft');expect(JSON.stringify(page)).not.toContain('private platform');expect(JSON.stringify(page)).not.toContain('private script');
});
it('marks an application element and prevents the original action',async()=>{
 document.body.innerHTML='<main data-localapp-app-root><button id="refresh">Refresh data</button></main>';
 const button=document.querySelector('button')!,handler=vi.fn();button.addEventListener('click',handler);
 const pending=markPageElement();button.click();
 await expect(pending).resolves.toMatchObject({text:'Refresh data',selector:'#refresh'});expect(handler).not.toHaveBeenCalled();expect(readPageContext().mark?.selector).toBe('#refresh');
});
it('drag selects a region and captures it instead of activating the element',async()=>{
 document.body.innerHTML='<main data-localapp-app-root><button>Do not activate</button></main>';
 const root=document.querySelector('main')!,button=document.querySelector('button')!,handler=vi.fn();button.addEventListener('click',handler);
 vi.spyOn(root,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:800,bottom:600,width:800,height:600,toJSON(){}});
 const draw=vi.fn();const context=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as any);
 const image=vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,cGljdHVyZQ==');
 const {toCanvas}=await import('html-to-image');vi.mocked(toCanvas).mockResolvedValue(document.createElement('canvas'));
 const pending=markPageElement();
 button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:40,clientY:50,button:0}));
 document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:200,clientY:150}));
 document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:200,clientY:150}));button.click();
 await expect(pending).resolves.toMatchObject({kind:'region',bounds:{x:40,y:50,width:160,height:100},image:'data:image/png;base64,cGljdHVyZQ=='});
 expect(handler).not.toHaveBeenCalled();expect(readPageContext().mark).not.toHaveProperty('image');expect(draw).toHaveBeenCalled();
 context.mockRestore();image.mockRestore();
});
vi.mock('html-to-image',()=>({toCanvas:vi.fn(),toSvg:vi.fn()}));
it('measures the live marked element, sticky table header and scrolling ancestors',async()=>{
 document.body.innerHTML='<main data-localapp-app-root><div style="overflow-y:auto;height:300px"><table><thead style="position:sticky;top:44px"><tr><th style="position:sticky;top:0px;z-index:5">Name</th></tr></thead><tbody><tr><td>Example</td></tr></tbody></table></div></main>';
 const cell=document.querySelector('td')!,scroller=document.querySelector('main > div')!;
 const pending=markPageElement();cell.click();await pending;
 Object.defineProperty(scroller,'scrollTop',{value:140,configurable:true});
 vi.spyOn(cell,'getBoundingClientRect').mockReturnValue({x:10,y:220,width:180,height:40,left:10,top:220,right:190,bottom:260,toJSON(){}});
 const page=readPageContext();
 expect(page.mark).toMatchObject({bounds:{y:220},layout:{bounds:{y:220},ancestors:expect.arrayContaining([expect.objectContaining({styles:expect.objectContaining({'overflow-y':'auto'}),scroll:expect.objectContaining({top:140})})])}});
 expect(page.layout.tables[0].headerGroup?.styles).toMatchObject({position:'sticky',top:'44px'});
 expect(page.layout.tables[0].headers[0].styles).toMatchObject({position:'sticky',top:'0px','z-index':'5'});
 expect(page.layout.tables[0].rows[0].cells[0].bounds.height).toBe(40);
});
it('omits explicitly private content and bounds table diagnostics',()=>{
 document.body.innerHTML='<main data-localapp-app-root><div data-localapp-private><h1>private-token</h1><table><thead><tr><th>Private header</th></tr></thead></table></div>'+Array.from({length:8},()=>'<table><tbody>'+Array.from({length:20},()=>'<tr><td>Value</td></tr>').join('')+'</tbody></table>').join('')+'</main>';
 const page=readPageContext();expect(JSON.stringify(page)).not.toContain('private-token');expect(JSON.stringify(page)).not.toContain('Private header');
 expect(page.layout.tables).toHaveLength(5);expect(page.layout.tables[0].rows).toHaveLength(3);
});
it('automates declared test controls and records failed assertions without activating other buttons',async()=>{
 const {executePreviewCheck}=await import('./page-context');
 document.body.innerHTML='<main data-localapp-app-root><button id="delete">Delete</button><button id="tab" role="tab">Details</button><h1>Before</h1></main>';
 const remove=vi.fn();document.querySelector('#delete')!.addEventListener('click',remove);
 document.querySelector('#tab')!.addEventListener('click',()=>{document.querySelector('h1')!.textContent='Details';});
 const blocked=await executePreviewCheck([{action:'click',selector:'#delete'}]);expect(blocked.status).toBe('failed');expect(remove).not.toHaveBeenCalled();
 const passed=await executePreviewCheck([{action:'click',selector:'#tab'},{action:'assert',selector:'h1',text:'Details'}]);expect(passed.status).toBe('passed');
 const failed=await executePreviewCheck([{action:'assert',selector:'h1',text:'Other'}]);expect(failed.status).toBe('failed');expect(failed.results[0]).toHaveProperty('error');
});
it('captures an offscreen preview without waiting for animation frames',async()=>{
 const {capturePageRegion}=await import('./page-context'),{toSvg}=await import('html-to-image');
 document.body.innerHTML='<main data-localapp-app-root><h1>Test</h1></main>';
 vi.spyOn(document.querySelector('main')!,'getBoundingClientRect').mockReturnValue({x:0,y:0,width:100,height:100,left:0,top:0,right:100,bottom:100,toJSON(){}});
 vi.mocked(toSvg).mockResolvedValue('data:image/svg+xml,svg');
 const decode=vi.fn(async()=>{});vi.stubGlobal('Image',class {src='';decode=decode});
 const draw=vi.fn(),context=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as any),png=vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,aW1hZ2U=');
 const raf=vi.spyOn(window,'requestAnimationFrame');
 expect(await capturePageRegion({x:0,y:0,width:50,height:50},true)).toBe('data:image/png;base64,aW1hZ2U=');expect(decode).toHaveBeenCalledOnce();expect(draw).toHaveBeenCalledTimes(2);expect(raf).not.toHaveBeenCalled();
 context.mockRestore();png.mockRestore();raf.mockRestore();vi.unstubAllGlobals();
});

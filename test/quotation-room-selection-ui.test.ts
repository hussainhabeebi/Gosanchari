// @ts-expect-error Node-only browser regression fixture.
import {readFileSync} from 'node:fs'
// @ts-expect-error Node-only isolated browser regression fixture.
import {runInNewContext} from 'node:vm'
import {it,expect} from 'vitest'
const source=readFileSync('public/app.js','utf8')
function box(id:string){
 const formHandlers:any={},boxHandlers:any={};let addClick:()=>void=()=>{}
 const makeSelect=(value:string)=>({value,options:['1','2','3'].map(value=>({value,disabled:false})),focus(){},dispatchEvent(){formHandlers.change?.()}})
 const primary=makeSelect('1'),form={elements:{['room_'+id]:primary},addEventListener(type:string,fn:any){formHandlers[type]=fn}}
 const rows:any[]=[];const list={querySelectorAll(){return rows.map(r=>r.select)},appendChild(row:any){rows.push(row)}}
 const makeRow=()=>{const row:any={select:makeSelect('1'),querySelector(){return row.select},remove(){rows.splice(rows.indexOf(row),1)}};return row}
 const add={disabled:false,addEventListener(_:string,fn:any){addClick=fn}}
 const root={dataset:{extraRooms:id},closest(){return form},querySelector(selector:string){return selector==='[data-extra-room-list]'?list:selector==='[data-extra-room-template]'?{content:{firstElementChild:{cloneNode:makeRow}}}:add},addEventListener(type:string,fn:any){boxHandlers[type]=fn}}
 const initial=makeRow();initial.select.value='2';rows.push(initial)
 return {root,primary,rows,add,clickAdd:()=>addClick(),change:()=>formHandlers.change(),remove:(row:any)=>boxHandlers.click({target:{closest:()=>({closest:()=>row})}})}
}
it('disables used room categories per option, re-enables removed categories, and selects the next unused category',()=>{
 const one=box('1'),two=box('2');runInNewContext(source.split('// Admin → Resort contacts:')[0],{document:{querySelectorAll:()=>[one.root,two.root]},Event:class{}})
 expect(one.rows[0].select.options[0].disabled).toBe(true);expect(one.primary.options[1].disabled).toBe(true)
 one.clickAdd();expect(one.rows.map(r=>r.select.value)).toEqual(['2','3']);expect(one.add.disabled).toBe(true)
 expect(two.add.disabled).toBe(false);expect(two.rows).toHaveLength(1)
 one.remove(one.rows[0]);expect(one.add.disabled).toBe(false);expect(one.primary.options[1].disabled).toBe(false)
 one.clickAdd();expect(one.rows.map(r=>r.select.value)).toEqual(['3','2'])
 one.primary.value='2';one.rows[1].select.value='1';one.change();expect(one.rows[0].select.options[1].disabled).toBe(true)
})
it('requires saving pending Admin edits before the Approve button remains available',()=>{
 let changed:()=>void=()=>{};const approve={disabled:false,textContent:'Approve'},edit={addEventListener(_:string,fn:any){changed=fn}}
 runInNewContext(source.split('// Approval uses')[1].split('\n').slice(1).join('\n'),{document:{querySelector:(s:string)=>s==='[data-confirmation-edit]'?edit:approve}})
 expect(approve.disabled).toBe(false);changed();expect(approve.disabled).toBe(true);expect(approve.textContent).toContain('Save Admin edits')
})

// @ts-expect-error Node-only local configuration fixture.
import {readFileSync} from 'node:fs'
// @ts-expect-error Production CLI module, tested with injected IO and no real processes.
import {deployProduction,PRODUCTION_D1_ID} from '../scripts/deploy.mjs'
import {describe,it,expect} from 'vitest'
const config=readFileSync('wrangler.toml','utf8'),kvId='1234567890abcdef1234567890abcdef'
function fixture(change:{config?:string;info?:any;kv?:any;migration?:number;deploy?:number}={}) {
 const calls:string[][]=[],writes:string[]=[]
 const run=(args:string[])=>{calls.push(args);if(args[0]==='d1'&&args[1]==='info')return change.info??{status:0,stdout:JSON.stringify({uuid:PRODUCTION_D1_ID,name:'gosanchari'})};if(args[0]==='kv')return change.kv??{status:0,stdout:JSON.stringify([{title:'gosanchari-kv',id:kvId}])};if(args[0]==='d1')return {status:change.migration??0};return {status:change.deploy??0}}
 return {calls,writes,start:()=>deployProduction({run,read:()=>change.config??config,write:(_:string,text:string)=>writes.push(text),log:()=>{}})}
}
describe('production deployment: existing resources only',()=>{
 it('pins the approved DB and existing KV, applies migrations first, activates once, and restores config',()=>{
  const f=fixture();f.start();expect(f.calls).toEqual([['d1','info','gosanchari','--json'],['kv','namespace','list'],['d1','migrations','apply','gosanchari','--remote'],['deploy']]);expect(f.writes[0]).toContain(`database_id = "${PRODUCTION_D1_ID}"`);expect(f.writes[0]).toContain(`id = "${kvId}"`);expect(f.writes.at(-1)).toBe(config)
 })
 it.each([{status:1,stderr:'Database not found'},{status:1,stderr:'Permission denied'},{status:0,stdout:'{}'},{status:0,stdout:JSON.stringify({uuid:'wrong-db',name:'gosanchari'})}])('stops on missing, inaccessible, invalid or mismatched D1: %j',info=>{
  const f=fixture({info});expect(f.start).toThrow();expect(f.calls).toHaveLength(1);expect(f.writes).toEqual([])
 })
 it.each([{status:1,stderr:'Permission denied'},{status:0,stdout:'[]'},{status:0,stdout:JSON.stringify([{title:'another-kv',id:kvId}])},{status:0,stdout:JSON.stringify([{title:'gosanchari-kv',id:'invalid'}])},{status:0,stdout:JSON.stringify([{title:'gosanchari-kv',id:kvId},{title:'gosanchari-kv',id:kvId}])}])('stops on missing, inaccessible, mismatched or ambiguous KV: %j',kv=>{
  const f=fixture({kv});expect(f.start).toThrow();expect(f.calls).toHaveLength(2);expect(f.writes).toEqual([])
 })
 it('rejects an incorrect configured D1 UUID before making any API call',()=>{
  const f=fixture({config:config.replace(PRODUCTION_D1_ID,'wrong-uuid')});expect(f.start).toThrow(/configuration/);expect(f.calls).toEqual([])
 })
 it('rejects a configured KV ID that differs from the existing resource',()=>{
  const f=fixture({config:config.replace('binding = "KV"','binding = "KV"\nid = "abcdef1234567890abcdef1234567890"')});expect(f.start).toThrow(/KV ID/);expect(f.calls).toHaveLength(2)
 })
 it('never activates the Worker after a migration failure and restores configuration',()=>{
  const f=fixture({migration:1});expect(f.start).toThrow(/Migrations failed/);expect(f.calls).toHaveLength(3);expect(f.writes.at(-1)).toBe(config)
 })
 it('does not retry a failed deployment or run any provisioning/seeding commands',()=>{
  const f=fixture({deploy:1});expect(f.start).toThrow(/No retry/);expect(f.calls.filter(c=>c[0]==='deploy')).toHaveLength(1);expect(f.writes.at(-1)).toBe(config);expect(f.calls.flat()).not.toContain('create');expect(f.calls.flat()).not.toContain('execute')
 })
})

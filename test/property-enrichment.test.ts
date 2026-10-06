import { describe, expect, it, vi } from 'vitest'
import { aiJson, aiText } from '../src/lib/ai'
import { runJob } from '../src/jobs/queue'

vi.mock('../src/lib/ai', async (original) => ({...await original<typeof import('../src/lib/ai')>(),aiJson:vi.fn(),aiText:vi.fn()}))

describe('wizard property enrichment',()=>{
  it.each(['', 'Manually retained legacy description'])('keeps location jobs without generating descriptions: %s',async(description)=>{
    vi.mocked(aiJson).mockReset();vi.mocked(aiText).mockReset()
    vi.mocked(aiJson).mockResolvedValue({how_to_reach:'Existing location enrichment',nearby:[{name:'Nearby attraction',kind:'attraction',km:5}]})
    const property={id:123,name:'Enrichment test',destination:'Munnar',description,description_ml:'Retain Malayalam',highlights:'["Keep manual highlight"]',how_to_reach:'',nearby:'[]'}
    const writes:{sql:string;values:any[]}[]=[]
    const env:any={DB:{prepare(sql:string){let values:any[]=[];const statement={bind(...v:any[]){values=v;return statement},async first(){return {...property}},async run(){writes.push({sql,values})}};return statement}}}
    await runJob(env,{type:'enrich_property',propertyId:123})
    expect(aiText).not.toHaveBeenCalled()
    expect(aiJson).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
    expect(writes[0].sql).toContain('how_to_reach = ?')
    expect(writes[0].sql).toContain('nearby = ?')
    expect(writes[0].sql).not.toMatch(/description|highlights/)
    expect(writes[0].values[0]).toBe('Existing location enrichment')
    expect(property.description).toBe(description)
    expect(property.description_ml).toBe('Retain Malayalam')
  })
  it('leaves populated enrichment fields and descriptions untouched',async()=>{
    vi.mocked(aiJson).mockClear();vi.mocked(aiText).mockClear()
    const run=vi.fn()
    const env:any={DB:{prepare(){const statement={bind(){return statement},async first(){return {description:'Keep',description_ml:'Keep ML',how_to_reach:'Already supplied',nearby:'[{"name":"Already supplied"}]'}},run};return statement}}}
    await runJob(env,{type:'enrich_property',propertyId:123})
    expect(aiJson).not.toHaveBeenCalled();expect(aiText).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled()
  })
})

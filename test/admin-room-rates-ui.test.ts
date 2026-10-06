// @ts-expect-error Node-only local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Node-only local test fixture.
import { runInNewContext } from 'node:vm'
// @ts-expect-error Node 24 SQLite local test fixture.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'

// Exercise the shipped client handler with a small DOM fixture, including tab navigation/reload.
function rateStep(storage: Map<string, string>, ids = [101, 102, 103], restored: Record<string,string> = {}) {
  const events = (obj: any) => Object.assign(obj, {
    listeners: {} as Record<string, () => void>,
    addEventListener(name: string, fn: () => void) { this.listeners[name] = fn },
    fire(name: string) { this.listeners[name]?.() },
  })
  const panels = ids.map(id => {
    const inputs: any[] = []
    for (const period of ['off', 'sea']) {
      for (const suffix of ['from', 'to']) inputs.push({name: `r${id}_${period}_${suffix}`, type: 'date', value: '', defaultValue: ''})
      for (const day of ['wk', 'we']) for (const plan of ['CP', 'MAP', 'AP', 'EP']) for (const tier of ['direct', 'staff', 'b2b']) inputs.push({name: `r${id}_${period}_${day}_${plan}_${tier}`, type: 'number', value: '', defaultValue: ''})
    }
    const peak = () => ({inputs: ['from', 'to', 'amt', 'desc'].map(s => ({name: `r${id}_peak_${s}`, type: s === 'amt' ? 'number' : 'text', value: '', defaultValue: ''})), cloneNode() { return peak() }})
    inputs.forEach(input => { input.value = restored[input.name] ?? '' })
    const peaks: any = {children: [peak()], appendChild(row: any) { this.children.push(row) }, get lastElementChild() { return this.children.at(-1) }}
    return {dataset: {rateRoom: String(id)}, hidden: false, inputs, peaks}
  })
  const statuses = ids.map(id => ({dataset: {rateStatus: String(id)}, textContent: ''}))
  const buttons = ids.map(id => events({dataset: {viewRateRoom: String(id)}, scrollIntoView() {}}))
  const next = events({}), form: any = events({dataset: {ratesDraft: '1'}, getAttribute() { return '/admin/properties/99/setup/3' }})
  const select: any = events({options: ids.map(id => ({value: String(id)})), selectedIndex: 0, closest() { return form }, scrollIntoView() {}})
  Object.defineProperty(select, 'value', {get() { return this.options[this.selectedIndex].value }, set(v) { this.selectedIndex = this.options.findIndex((o: any) => o.value === v) }})
  const window = events({})
  const queryAll = (s: string, root: any) => {
    if (s === '[data-rate-room]') return panels
    if (s === '[data-view-rate-room]') return buttons
    if (s === 'input' || s === 'input[type="number"]') {
      const inputs = root.inputs ? [...root.inputs, ...(root.peaks?.children.flatMap((r: any) => r.inputs) ?? [])] : []
      return s === 'input' ? inputs : inputs.filter(i => i.type === 'number')
    }
    return []
  }
  const query = (s: string, root: any) => s === '[data-room-select]' ? select : s === '[data-next-room]' ? next : s === '[data-peaks]' ? root.peaks : statuses.find(x => s === `[data-rate-status="${x.dataset.rateStatus}"]`)
  const source = readFileSync('public/app.js', 'utf8') as string
  runInNewContext(source.slice(source.indexOf('  var roomSel ='), source.indexOf("  $$('[data-add-peak]')")), {
    $: query, $$: queryAll, window, alert() {}, sessionStorage: {getItem(k: string) {return storage.get(k)}, setItem(k: string, v: string) {storage.set(k,v)}, removeItem(k: string) {storage.delete(k)}},
  })
  const fields = () => panels.flatMap(p => queryAll('input', p))
  return {panels, statuses, buttons, select, next, form, window, fields, set(name: string, value: string) {fields().find(i => i.name === name)!.value = value; form.fire('input')}}
}

describe('Admin room rate step', () => {
  it.each(['dropdown','View/Edit'])('hydrates exact visible Room A inputs via %s after a partial browser restore', via => {
    const storage = new Map<string,string>()
    let ui = rateStep(storage)
    ui.fields().filter(i=>i.name.startsWith('r101_')).forEach((input,index)=>{
      // Both periods, all plans/tiers/day types, peaks and intentional blanks.
      const value = input.name.endsWith('_from') ? '2030-01-01' : input.name.endsWith('_to') ? '2030-01-31' : input.name.endsWith('_desc') ? 'Peak holiday' : index % 3 ? String(7000 + index) : ''
      ui.set(input.name,value)
    })
    const original = ui.fields().filter(i=>i.name.startsWith('r101_')).map(i=>[i.name,i.value])
    ui.next.fire('click'); ui.set('r102_off_wk_CP_direct','9000')
    // A hidden form panel is not the source of truth. Reopening must hydrate
    // its actual inputs even if the browser has cleared those hidden controls.
    ui.fields().filter(i=>i.name.startsWith('r101_')).forEach(input=>{input.value=''})
    if (via === 'dropdown') {ui.select.value='101'; ui.select.fire('change')}
    else ui.buttons[0].fire('click')
    expect(ui.panels[0].hidden).toBe(false)
    expect(ui.fields().filter(i=>i.name.startsWith('r101_')).map(i=>[i.name,i.value])).toEqual(original)
    ui.next.fire('click')
    expect(ui.fields().find(i=>i.name==='r102_off_wk_CP_direct')!.value).toBe('9000')
    ui.window.fire('pagehide')
    // Browsers can restore only part of a form before the script runs. This is
    // current DOM state, not a changed saved server value/defaultValue.
    ui = rateStep(storage,[101,102,103],{r101_sea_we_AP_staff:'9999'})
    expect(ui.statuses[0].textContent).toBe('Rates added ✓')
    if (via === 'dropdown') {ui.select.value='101'; ui.select.fire('change')}
    else ui.buttons[0].fire('click')
    const visible = ui.panels.filter(p=>!p.hidden)
    expect(visible.map(p=>p.dataset.rateRoom)).toEqual(['101'])
    expect([...visible[0].inputs,...visible[0].peaks.children.flatMap((r:any)=>r.inputs)].map(i=>[i.name,i.value])).toEqual(original)
    // Never read values from hidden Room B to satisfy Room A's assertion.
    expect(ui.fields().find(i=>i.name==='r102_off_wk_CP_direct')!.value).toBe('9000')
  })
  it('retains exact independent room values, status, blank cells and Previous/Next drafts', () => {
    const storage = new Map<string, string>()
    let ui = rateStep(storage)
    expect(ui.statuses.map(s => s.textContent)).toEqual(['Not added','Not added','Not added'])
    ui.set('r101_off_from', '2030-01-01')
    ui.set('r101_off_to', '2030-01-31')
    expect(ui.statuses[0].textContent).toBe('Not added')
    ui.set('r101_off_wk_CP_direct', '7000')
    ui.set('r101_off_we_MAP_staff', '6500')
    ui.next.fire('click')
    expect(ui.select.value).toBe('102')
    ui.set('r102_sea_from', '2030-02-01')
    ui.set('r102_sea_to', '2030-02-28')
    ui.set('r102_sea_wk_AP_direct', '9000')
    ui.set('r102_sea_we_EP_b2b', '8000')
    const original = ui.fields().map(i => [i.name,i.value])
    ui.buttons[0].fire('click')
    expect(ui.panels.map(p => p.hidden)).toEqual([false,true,true])
    expect(ui.fields().map(i => [i.name,i.value])).toEqual(original)
    ui.select.value = '102'; ui.select.fire('change')
    expect(ui.panels.map(p => p.hidden)).toEqual([true,false,true])
    expect(ui.statuses.map(s => s.textContent)).toEqual(['Rates added ✓','Rates added ✓','Not added'])
    ui.next.fire('click')
    expect(ui.statuses[2].textContent).toBe('Not added')
    // Previous leaves the document; returning from Step 2 restores the tab-local draft.
    ui.window.fire('pagehide'); ui = rateStep(storage)
    expect(ui.fields().map(i => [i.name,i.value])).toEqual(original)
    ui.buttons[0].fire('click'); ui.set('r101_off_wk_CP_direct', '7100')
    ui.form.fire('submit')
    expect(ui.fields().find(i => i.name === 'r102_sea_wk_AP_direct')!.value).toBe('9000')
    expect(ui.fields().find(i => i.name === 'r101_off_wk_MAP_direct')!.value).toBe('')
  })

  it.each([false, true])('submits independent room drafts, including private-only CP: %s', async (privateOnly) => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file,'utf8'))
      db.exec(readFileSync('seed/seed.sql','utf8'))
      const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get() as any
      const property = db.prepare('SELECT id FROM properties ORDER BY id LIMIT 1').get() as any
      const unrelated = JSON.stringify(db.prepare('SELECT * FROM properties WHERE id != ?').all(property.id))
      const ids = ['UX Room 1','UX Room 2','UX Room 3'].map(name => Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate) VALUES (?,?,0)').run(property.id,name).lastInsertRowid))
      const DB = {prepare(sql: string) {
        let binds: any[] = []
        const st = {bind(...v: any[]) {binds=v; return st}, async all() {return {results:db.prepare(sql).all(...binds)}}, async first() {return db.prepare(sql).get(...binds) ?? null}, async run() {const r=db.prepare(sql).run(...binds); return {meta:{last_row_id:Number(r.lastInsertRowid)}}}}
        return st
      }, async batch(stmts: any[]) {return Promise.all(stmts.map(s=>s.run()))}}
      const env: any = {DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
      const app = new Hono<any>().use('*',async(c,next)=>{c.set('user',user); await next()}).route('/',wizardRoutes)
      const ui = rateStep(new Map(), ids)
      ui.set(`r${ids[0]}_off_from`,'2030-01-01'); ui.set(`r${ids[0]}_off_to`,'2030-01-31'); ui.set(`r${ids[0]}_off_wk_CP_direct`,'7000')
      ui.next.fire('click')
      ui.set(`r${ids[1]}_sea_from`,'2030-02-01'); ui.set(`r${ids[1]}_sea_to`,'2030-02-28'); ui.set(`r${ids[1]}_sea_wk_AP_direct`,'9000')
      if (privateOnly) {
        ui.buttons[0].fire('click')
        ui.set(`r${ids[0]}_off_wk_CP_direct`,'')
        ui.set(`r${ids[0]}_off_wk_CP_staff`,'3250'); ui.set(`r${ids[0]}_off_we_CP_staff`,'3500')
        ui.set(`r${ids[0]}_off_wk_CP_b2b`,'3000'); ui.set(`r${ids[0]}_off_we_CP_b2b`,'3250')
        ui.next.fire('click')
        ui.set(`r${ids[1]}_sea_wk_AP_direct`,'')
        ui.set(`r${ids[1]}_sea_wk_CP_staff`,'3800'); ui.set(`r${ids[1]}_sea_we_CP_staff`,'4000')
        ui.set(`r${ids[1]}_sea_wk_CP_b2b`,'3500'); ui.set(`r${ids[1]}_sea_we_CP_b2b`,'3750')
        const draft = ui.fields().map(i=>[i.name,i.value])
        ui.buttons[0].fire('click'); ui.select.value=String(ids[1]); ui.select.fire('change')
        expect(ui.fields().map(i=>[i.name,i.value])).toEqual(draft)
        expect(ui.statuses.map(s=>s.textContent)).toEqual(['Rates added ✓','Rates added ✓','Not added'])
      }
      ui.buttons[0].fire('click')
      const body = new URLSearchParams(ui.fields().map(i=>[i.name,i.value]))
      const response = await app.request(`http://localhost/admin/properties/${property.id}/setup/3`,{method:'POST',body},env)
      expect(response.status).toBe(303)
      const rows = db.prepare("SELECT room_id,meal_plan,rate,weekend_rate,staff_rate,net_rate FROM season_rates WHERE source='wizard' ORDER BY room_id").all()
      expect(rows.map((r: any)=>({...r}))).toEqual(privateOnly ? [
        {room_id:ids[0],meal_plan:'CP',rate:null,weekend_rate:null,staff_rate:3250,net_rate:3000},
        {room_id:ids[1],meal_plan:'CP',rate:null,weekend_rate:null,staff_rate:3800,net_rate:3500},
      ] : [
        {room_id:ids[0],meal_plan:'CP',rate:7000,weekend_rate:null,staff_rate:null,net_rate:null},
        {room_id:ids[1],meal_plan:'AP',rate:9000,weekend_rate:null,staff_rate:null,net_rate:null},
      ])
      if (privateOnly) {
        expect(db.prepare('SELECT rate_meal_plan,meal_plans FROM properties WHERE id=?').get(property.id)).toMatchObject({rate_meal_plan:'CP',meal_plans:'["CP"]'})
        expect(db.prepare('SELECT base_rate FROM rooms WHERE id=?').get(ids[0])).toMatchObject({base_rate:0})
        expect(db.prepare("SELECT staff_weekend_rate,net_weekend_rate FROM season_rates WHERE source='wizard' AND room_id=?").get(ids[0])).toMatchObject({staff_weekend_rate:3500,net_weekend_rate:3250})
      }
      expect(JSON.stringify(db.prepare('SELECT * FROM properties WHERE id != ?').all(property.id))).toBe(unrelated)
    } finally {db.close()}
  })

  it('restores repeated peak rows and keeps drafts scoped to their room', () => {
    const storage = new Map<string,string>()
    let ui = rateStep(storage)
    const peaks = ui.panels[0].peaks
    peaks.appendChild(peaks.lastElementChild.cloneNode(true))
    peaks.children[0].inputs[0].value = '2030-12-24'
    peaks.children[0].inputs[2].value = '1000'
    peaks.children[1].inputs[0].value = '2030-12-31'
    peaks.children[1].inputs[2].value = '2000'
    ui.form.fire('input'); ui.window.fire('pagehide')
    ui = rateStep(storage)
    expect(ui.panels[0].peaks.children.map((p: any)=>p.inputs[2].value)).toEqual(['1000','2000'])
    expect(ui.panels[1].peaks.children[0].inputs[2].value).toBe('')
    expect(ui.statuses.map(s=>s.textContent)).toEqual(['Rates added ✓','Not added','Not added'])
    // Adding another category in Step 2 must not discard existing room drafts.
    ui = rateStep(storage,[101,102,103,104])
    expect(ui.panels[0].peaks.children.map((p: any)=>p.inputs[2].value)).toEqual(['1000','2000'])
    expect(ui.statuses[3].textContent).toBe('Not added')
    // Changed saved server rates invalidate that room's draft, avoiding stale overwrites.
    const key = [...storage.keys()][0], draft = JSON.parse(storage.get(key)!)
    const base = JSON.parse(draft.base); base[0].fields[0].value = '2031-01-01'; draft.base = JSON.stringify(base)
    storage.set(key,JSON.stringify(draft))
    ui = rateStep(storage)
    expect(ui.panels[0].peaks.children[0].inputs[2].value).toBe('')
  })
})

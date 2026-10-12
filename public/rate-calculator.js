// Estimates only: the server resolves all prices. No pricing or persistence in this script.
(() => {
  const form = document.querySelector('[data-rate-calculator]'); if (!form) return;
  const list = form.querySelector('[data-calculator-rooms]'), add = form.querySelector('[data-calculator-add]');
  const status = form.querySelector('[data-calculator-status]'), results = document.querySelector('[data-calculator-results]');
  let rooms = [], revision = 0, controller, roomController, roomsRevision = 0;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const money = n => '₹' + Number(n).toLocaleString('en-IN', {maximumFractionDigits: 2});
  const calculating = active => form.querySelectorAll('[data-calculator-calculate]').forEach(button => button.disabled = active);
  const invalidate = () => { revision++; controller?.abort(); results.replaceChildren(); status.textContent = ''; calculating(false); };
  function sync() {
    const rows = [...list.children], used = rows.map(row => row.querySelector('select').value);
    rows.forEach(row => {
      const select = row.querySelector('select'); [...select.options].forEach(o => o.disabled = o.value !== select.value && used.includes(o.value));
      const room = rooms.find(r => String(r.id) === select.value);
      const count = Number(row.querySelector('input').value);
      const hint = row.querySelector('[data-inventory]');
      hint.textContent = room ? (room.units > 0 ? `Total rooms in category: ${room.units} — live availability not verified.${count > room.units ? ` Requested ${count}; please verify with the property.` : ''}` : 'Category inventory not supplied — live availability not verified.') : '';
      const policy = row.querySelector('[data-kids-policy]');
      policy.textContent = room ? [room.child_free_below != null ? `Below ${room.child_free_below} years: complimentary` : '', room.child_age_to != null ? `Child policy upper age: ${room.child_age_to}` : '', room.extra_child_rate != null ? `Child with bed: ${money(room.extra_child_rate)} / night` : '', room.child_no_bed_rate != null ? `Child without bed: ${money(room.child_no_bed_rate)} / night` : ''].filter(Boolean).join(' · ') : '';
      hint.className = room?.units > 0 && count > room.units ? 'small alert-amber' : 'small muted';
    });
    add.disabled = !rooms.length || rows.length >= Math.min(20, rooms.length);
  }
  function append() {
    const used = [...list.querySelectorAll('select')].map(s => s.value), room = rooms.find(r => !used.includes(String(r.id))); if (!room) return;
    const row = el('div', null, 'calculator-room');
    const label = el('label'), select = el('select'); label.append(el('span', 'Room Category', 'field-label')); select.required = true;
    rooms.forEach(r => { const o = el('option', r.name); o.value = String(r.id); select.append(o); }); select.value = String(room.id); label.append(select);
    const qty = el('label'), input = el('input'); qty.append(el('span', 'No. of Rooms', 'field-label')); input.type = 'number'; input.min = '1'; input.max = '100'; input.value = '1'; input.required = true; qty.append(input);
    const remove = el('button', 'Remove', 'btn btn-sm btn-outline'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); invalidate(); sync(); });
    const hint = el('p'); hint.dataset.inventory = ''; const policy = el('p', null, 'small muted'); policy.dataset.kidsPolicy = ''; row.append(label, qty, remove, hint, policy); list.append(row); sync();
  }
  form.elements.property.addEventListener('change', async () => {
    invalidate(); roomController?.abort(); rooms = []; list.replaceChildren(); sync(); const version = ++roomsRevision;
    if (!form.elements.property.value) return;
    roomController = new AbortController(); status.textContent = 'Loading rooms…';
    try { const r = await fetch('/staff/rate-calculator/rooms?property=' + encodeURIComponent(form.elements.property.value), {signal: roomController.signal}); const data = await r.json(); if (!r.ok) throw Error(data.error || 'Could not load rooms.'); if (version !== roomsRevision) return; rooms = data.rooms; append(); status.textContent = rooms.length ? '' : 'No active room categories.'; }
    catch(e) { if (version === roomsRevision && e.name !== 'AbortError') status.textContent = e.message; }
  });
  add.addEventListener('click', () => { invalidate(); append(); });
  list.addEventListener('change', () => { invalidate(); sync(); });
  form.addEventListener('input', () => { invalidate(); sync(); });
  form.addEventListener('change', event => { if (event.target !== form.elements.property) { invalidate(); sync(); } });
  form.querySelector('[data-calculator-clear]').addEventListener('click', () => { invalidate(); roomsRevision++; roomController?.abort(); form.reset(); rooms = []; list.replaceChildren(); sync(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    invalidate(); const version = revision; controller = new AbortController(); status.textContent = 'Calculating…'; calculating(true);
    const payload = {}; ['property','adults','extraAdults','children','kidsAmount','discount','additional'].forEach(k => payload[k] = Number(form.elements[k].value));
    ['checkIn','checkOut','mealPlan'].forEach(k => payload[k] = form.elements[k].value); payload.applyGst = form.elements.applyGst.checked;
    payload.rooms = [...list.children].map(row => ({id:Number(row.querySelector('select').value),count:Number(row.querySelector('input').value)}));
    try {
      const response = await fetch('/staff/rate-calculator/calculate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal}); const data = await response.json(); if (!response.ok) throw Error(data.error || 'Calculation failed.'); if (version !== revision) return;
      results.append(el('p', `${data.totalRooms} rooms · ${data.guests} guests · Combined capacity: ${data.capacity}. Live availability not verified.`));
      data.warnings.forEach(w => results.append(el('p', w, 'flash flash-err')));
      // Only server-authorised tiers exist here; never infer or request a private tier.
      const tiers = [...data.tiers].sort((a, b) => ({net:0,staff:1,direct:2}[a.key] ?? 2) - ({net:0,staff:1,direct:2}[b.key] ?? 2));
      const label = tier => tier.key === 'direct' ? 'Guest / Direct' : tier.key === 'staff' ? 'Staff' : tier.key === 'net' ? 'B2B' : tier.label;
      const details = el('section', null, 'calculator-details'); details.append(el('h2', 'Rate Details'));
      const wrap = el('div', null, 'calculator-table'); wrap.tabIndex = 0;
      const table = el('table'), thead = el('thead'), head = el('tr');
      ['Room Category','No. of Rooms','Nights',...tiers.map(t => label(t) + ' / room / night'), ...tiers.map(t => label(t) + ' Total')].forEach(text => head.append(el('th', text))); thead.append(head); table.append(thead);
      const body = el('tbody');
      payload.rooms.forEach((selected, index) => {
        const configured = rooms.find(r => r.id === selected.id), line = tiers.find(t => t.available)?.rows[index];
        const tr = el('tr'); [configured?.name || line?.name || 'Selected room', selected.count, line?.nights ?? '—', ...tiers.map(t => t.available && t.rows[index] ? money(t.rows[index].average) : 'Not supplied'), ...tiers.map(t => t.available && t.rows[index] ? money(t.rows[index].total) : 'Unavailable')].forEach(text => tr.append(el('td',text))); body.append(tr);
      }); table.append(body); wrap.append(table); details.append(wrap);
      details.append(el('p', 'Nightly figures are stay averages including applicable peak supplements. Category totals include allocated extras, discount and GST.', 'small muted'));
      // Keep the server's full component breakdown available without repeating tier tables.
      const breakdown = el('details', null, 'calculator-components'); breakdown.append(el('summary', 'Detailed price breakdown'));
      tiers.filter(t => t.available).forEach(t => {
        const section = el('div', null, 'stack'); section.append(el('h3', label(t)));
        t.rows.forEach(r => section.append(el('p', `${r.name}: Accommodation ${money(r.accommodation)} · Extra adults ${money(r.extraAdults)} · Discount ${money(r.discount)} · Kids + additional ${money(r.extras)} · GST ${money(r.gst)} · Total ${money(r.total)}`, 'small')));
        breakdown.append(section);
      }); details.append(breakdown); results.append(details);
      tiers.filter(t => !t.available).forEach(t => results.append(el('p', `${label(t)} estimate unavailable. ${t.errors.join(' ')}`, 'flash flash-err')));
      const summaries = el('div', null, 'calculator-summaries');
      tiers.forEach(t => {
        const card = el('section', null, 'calculator-summary calculator-summary-' + t.key);
        card.append(el('h3', 'Total ' + label(t) + ' Rate'), el('strong', t.available ? money(t.total) : 'Unavailable'), el('p', t.available ? 'Inclusive of configured rooms and entered charges' : 'No valid applicable estimate', 'small muted'));
        if(t.maximumDiscount != null) card.append(el('p', 'Maximum accommodation discount: ' + money(t.maximumDiscount), 'small muted'));
        summaries.append(card);
      }); results.append(summaries); status.textContent = 'Estimate calculated. Nothing was saved.';
    } catch(e) { if(version === revision && e.name !== 'AbortError') status.textContent = e.message; }
    finally { if(version === revision) calculating(false); }
  });
})();

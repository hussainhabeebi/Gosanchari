// Go Sanchari client script: small progressive enhancements, no framework.
(function () {
  'use strict'
  var $ = function (s, r) { return (r || document).querySelector(s) }
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)) }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  var money = function (n) { return '₹' + Math.round(n || 0).toLocaleString('en-IN') }
  var json = function (id) { var el = document.getElementById(id); try { return el ? JSON.parse(el.textContent) : null } catch (e) { return null } }
  function post(url, data) {
    var body = new URLSearchParams()
    Object.keys(data || {}).forEach(function (k) { if (data[k] != null) body.append(k, data[k]) })
    return fetch(url, { method: 'POST', body: body, headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json() })
  }

  // Auto-submit selects
  $$('select.autosubmit').forEach(function (s) { s.addEventListener('change', function () { s.form && s.form.submit() }) })
  // Print buttons (CSP blocks inline handlers)
  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print() }) })

  // Disable submit buttons on submit to avoid double posts
  $$('form').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      var b = e.submitter
      if (b && b.tagName === 'BUTTON' && f.method.toLowerCase() === 'post') setTimeout(function () { b.disabled = true }, 0)
    })
  })

  // ---------- Gallery lightbox (every [data-gallery] block is its own set) ----------
  var box, set = [], idx = 0
  function show(list, i) {
    set = list
    idx = (i + set.length) % set.length
    if (!box) {
      box = document.createElement('div')
      box.className = 'lightbox'
      box.innerHTML = '<img alt=""><button class="lb-close" aria-label="Close">×</button><button class="lb-prev" aria-label="Previous">‹</button><button class="lb-next" aria-label="Next">›</button>'
      document.body.appendChild(box)
      box.addEventListener('click', function (e) {
        if (e.target.classList.contains('lb-prev')) show(set, idx - 1)
        else if (e.target.classList.contains('lb-next')) show(set, idx + 1)
        else if (e.target.tagName !== 'IMG') { box.remove(); box = null }
      })
    }
    $('img', box).src = set[idx].href
  }
  document.addEventListener('keydown', function (e) {
    if (!box) return
    if (e.key === 'Escape') { box.remove(); box = null }
    if (e.key === 'ArrowLeft') show(set, idx - 1)
    if (e.key === 'ArrowRight') show(set, idx + 1)
  })
  $$('[data-gallery]').forEach(function (gal) {
    var links = $$('[data-full]', gal)
    links.forEach(function (a, i) { a.addEventListener('click', function (e) { e.preventDefault(); show(links, i) }) })
  })

  // ---------- Maps (Leaflet, loaded with defer) ----------
  window.addEventListener('load', function () {
    if (!window.L) return
    var tiles = function (m) { L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(m) }
    var pm = document.getElementById('prop-map')
    if (pm) {
      var lat = +pm.dataset.lat, lng = +pm.dataset.lng
      var m = L.map(pm, { scrollWheelZoom: false }).setView([lat, lng], 13); tiles(m)
      L.marker([lat, lng]).addTo(m).bindPopup(esc(pm.dataset.name))
    }
    var rm = document.getElementById('results-map')
    if (rm) {
      var pts = json('map-data') || []
      var m2 = L.map(rm).setView([10.5, 76.5], 7); tiles(m2)
      var bounds = []
      pts.forEach(function (p) {
        L.marker([p.lat, p.lng]).addTo(m2).bindPopup('<a href="' + esc(p.href) + '"><strong>' + esc(p.name) + '</strong></a><br>' + esc(p.price) + ' / night')
        bounds.push([p.lat, p.lng])
      })
      if (bounds.length) m2.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 })
    }
    var pin = document.getElementById('pin-map')
    if (pin) {
      var la = $('#lat'), ln = $('#lng')
      var m3 = L.map(pin).setView([+pin.dataset.lat, +pin.dataset.lng], la.value ? 13 : 8); tiles(m3)
      var mk = la.value ? L.marker([+la.value, +ln.value]).addTo(m3) : null
      var mu = document.getElementById('map-url')
      if (mu) mu.addEventListener('change', function () {
        var v = mu.value, mm = v.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || v.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || v.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
        if (!mm) return
        la.value = (+mm[1]).toFixed(6); ln.value = (+mm[2]).toFixed(6)
        var ll = [+la.value, +ln.value]
        if (mk) mk.setLatLng(ll); else mk = L.marker(ll).addTo(m3)
        m3.setView(ll, 14)
      })
      m3.on('click', function (e) {
        la.value = e.latlng.lat.toFixed(6); ln.value = e.latlng.lng.toFixed(6)
        if (mk) mk.setLatLng(e.latlng); else mk = L.marker(e.latlng).addTo(m3)
      })
    }
    charts()
  })

  // ---------- Availability calendar ----------
  var cal = $('.avail-cal')
  if (cal) {
    var full = {}; (json('full-dates') || []).forEach(function (d) { full[d] = 1 })
    var start = new Date(cal.dataset.from + 'T00:00:00Z')
    var today = cal.dataset.from
    var html = ''
    for (var mo = 0; mo < (+cal.dataset.months || 2); mo++) {
      var first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + mo, 1))
      var days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
      html += '<div class="mcal"><table><caption>' + first.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + '</caption><tr>' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (d) { return '<th>' + d + '</th>' }).join('') + '</tr><tr>'
      for (var b = 0; b < first.getUTCDay(); b++) html += '<td></td>'
      for (var d = 1; d <= days; d++) {
        var iso = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d)).toISOString().slice(0, 10)
        var cls = iso < today ? 'past' : full[iso] ? 'full' : ''
        html += '<td class="' + cls + '" title="' + (full[iso] ? 'Fully booked' : '') + '">' + d + '</td>'
        if ((first.getUTCDay() + d) % 7 === 0) html += '</tr><tr>'
      }
      html += '</tr></table></div>'
    }
    cal.innerHTML = html
  }

  // ---------- Booking box live price ----------
  var bf = $('form[data-price-url]')
  if (bf) {
    var box2 = $('.price-box', bf)
    var timer
    function refresh() {
      clearTimeout(timer)
      timer = setTimeout(function () {
        var fd = new FormData(bf)
        var enq = $('[data-enquiry-link]', bf)
        if (enq) {
          var u = new URL(enq.href, location.href)
          ;['checkIn', 'checkOut'].forEach(function (k) { if (fd.get(k)) u.searchParams.set(k, fd.get(k)) })
          u.searchParams.set('adults', fd.get('adults') || 2)
          enq.href = u.pathname + u.search
        }
        if (!fd.get('check_in') || !fd.get('check_out')) return
        post(bf.dataset.priceUrl, { room: fd.get('room'), checkIn: fd.get('check_in'), checkOut: fd.get('check_out'), rooms: fd.get('rooms'), adults: fd.get('adults'), children: fd.get('children') }).then(function (p) {
          if (p.errors && p.errors.length) { box2.innerHTML = '<span class="error small">' + esc(p.errors[0]) + '</span>'; return }
          box2.innerHTML = '<div class="muted small">Estimated price (confirmed in your quote)</div><table class="breakdown"><tr><td>' + p.nights + ' night' + (p.nights > 1 ? 's' : '') + ' × ' + p.roomsCount + ' room' + (p.roomsCount > 1 ? 's' : '') + '</td><td>' + money(p.roomCharges != null ? p.roomCharges : p.subtotal) + '</td></tr>' +
            (p.extraGuests && p.extraGuests.total ? '<tr><td>Extra guests (' + [p.extraGuests.extraAdults ? p.extraGuests.extraAdults + ' adult' + (p.extraGuests.extraAdults > 1 ? 's' : '') : '', p.extraGuests.extraChildren ? p.extraGuests.extraChildren + ' child' + (p.extraGuests.extraChildren > 1 ? 'ren' : '') : ''].filter(Boolean).join(' + ') + ')</td><td>' + money(p.extraGuests.total) + '</td></tr>' : '') +
            (p.discount ? '<tr><td>Discount</td><td>− ' + money(p.discount) + '</td></tr>' : '') +
            '<tr><td>GST (' + p.taxRate + '%)</td><td>' + money(p.taxes) + '</td></tr><tr class="total"><td>Total</td><td>' + money(p.total) + '</td></tr></table>'
        }).catch(function () { box2.textContent = '' })
      }, 250)
    }
    $$('input,select', bf).forEach(function (i) { i.addEventListener('change', refresh) })
    var ci = $('input[name=check_in]', bf), co = $('input[name=check_out]', bf)
    ci.addEventListener('change', function () {
      if (ci.value && (!co.value || co.value <= ci.value)) { var d = new Date(ci.value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); co.value = d.toISOString().slice(0, 10) }
      co.min = ci.value
    })
    refresh()
    var wantRoom = new URLSearchParams(location.search).get('room')
    if (wantRoom && $('#room-select option[value="' + wantRoom.replace(/\D/g, '') + '"]')) { $('#room-select').value = wantRoom; refresh(); $('#book').scrollIntoView() }
    $$('[data-pick-room]').forEach(function (b) {
      b.addEventListener('click', function () { $('#room-select').value = b.dataset.pickRoom; refresh(); $('#book').scrollIntoView({ behavior: 'smooth' }) })
    })
  }

  // ---------- Property Q&A ----------
  var qa = $('[data-qa]')
  if (qa) {
    var log = $('.qa-log', qa), qf = $('.qa-form', qa), hf = $('.qa-handoff', qa)
    qf.addEventListener('submit', function (e) {
      e.preventDefault()
      var q = qf.q.value.trim(); if (!q) return
      log.insertAdjacentHTML('beforeend', '<div class="msg msg-guest">' + esc(q) + '</div><div class="msg msg-ai typing">…</div>')
      log.scrollTop = log.scrollHeight
      qf.q.value = ''
      post(qa.dataset.qa, { q: q }).then(function (r) {
        var t = $('.typing', log); t.classList.remove('typing'); t.textContent = r.answer || r.error || 'Sorry, something went wrong.'
        if (r.handoff) { hf.hidden = false; hf.message.value = 'Question from property page: ' + q }
        log.scrollTop = log.scrollHeight
      }).catch(function () { var t = $('.typing', log); t.classList.remove('typing'); t.textContent = 'Sorry, please try again.' })
    })
  }

  // ---------- Help chat (Durable Object WebSocket) ----------
  var chat = $('[data-chat]')
  if (chat) {
    var clog = $('.chat-log', chat), cf = $('.chat-form', chat), contact = $('.chat-contact', chat)
    var room = null
    try { room = localStorage.getItem('gs_chat_room') } catch (e) {}
    if (!room) { room = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9-]/g, ''); try { localStorage.setItem('gs_chat_room', room) } catch (e) {} }
    var ws, queue = [], retries = 0
    function line(l) {
      $$('.typing', clog).forEach(function (t) { t.remove() })
      var who = l.from === 'staff' ? (l.name || 'Go Sanchari team') : l.from === 'ai' ? 'Assistant' : ''
      clog.insertAdjacentHTML('beforeend', '<div class="msg msg-' + esc(l.from) + '">' + esc(l.text) + (who ? '<div class="muted small">' + esc(who) + '</div>' : '') + '</div>')
      clog.scrollTop = clog.scrollHeight
    }
    function connect() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/chat/ws?room=' + encodeURIComponent(room))
      ws.onopen = function () { retries = 0; queue.splice(0).forEach(function (m) { ws.send(m) }) }
      ws.onmessage = function (ev) {
        var m = JSON.parse(ev.data)
        if (m.type === 'hello') { m.history.forEach(line); if (m.mode === 'human') $('[data-handoff]', chat).hidden = true }
        if (m.type === 'line') { line(m.line); if (m.mode === 'human') $('[data-handoff]', chat).hidden = true }
        if (m.type === 'typing') clog.insertAdjacentHTML('beforeend', '<div class="msg msg-ai typing">typing…</div>')
        if (m.type === 'need_contact') {
          if (chat.dataset.phone && !m.error) send({ type: 'handoff', name: chat.dataset.name, phone: chat.dataset.phone })
          else { contact.hidden = false; if (m.error) alert(m.error) }
        }
      }
      ws.onclose = function () { if (retries++ < 5) setTimeout(connect, 1000 * retries) }
    }
    function send(obj) { var s = JSON.stringify(obj); if (ws && ws.readyState === 1) ws.send(s); else queue.push(s) }
    connect()
    cf.addEventListener('submit', function (e) { e.preventDefault(); var t = cf.text.value.trim(); if (t) { send({ type: 'msg', text: t }); cf.text.value = '' } })
    $('[data-handoff]', chat).addEventListener('click', function () {
      if (chat.dataset.phone) send({ type: 'handoff', name: chat.dataset.name, phone: chat.dataset.phone })
      else contact.hidden = false
    })
    contact.addEventListener('submit', function (e) { e.preventDefault(); send({ type: 'handoff', name: contact.elements.name.value, phone: contact.elements.phone.value }); contact.hidden = true })
  }

  // ---------- Staff/admin AI buttons ----------
  $$('[data-ai-post]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault()
      var old = b.textContent; b.disabled = true; b.textContent = 'Working…'
      post(b.dataset.aiPost, {}).then(function (r) {
        b.disabled = false; b.textContent = old
        if (r.error) { alert(r.error); return }
        if (b.dataset.fill) { var t = $(b.dataset.fill); t.value = r.text; t.focus() }
        if (b.dataset.target) { var el = $(b.dataset.target); el.textContent = r.text; el.classList.add('translation') }
      }).catch(function () { b.disabled = false; b.textContent = old; alert('Something went wrong') })
    })
  })
  $$('.template-pick').forEach(function (s) {
    s.addEventListener('change', function () { if (s.value) { var t = $('#reply-text'); t.value = s.value; t.focus(); s.value = '' } })
  })
  var descBtn = $('[data-ai-desc]')
  if (descBtn) descBtn.addEventListener('click', function () {
    var f = $('#prop-form'); var old = descBtn.textContent; descBtn.disabled = true; descBtn.textContent = 'Writing…'
    post(descBtn.dataset.aiDesc, { name: f.elements.name.value, type: f.elements.type.value, destination: f.elements.destination.value, points: $('#desc-points').value }).then(function (r) {
      descBtn.disabled = false; descBtn.textContent = old
      if (r.error) return alert(r.error)
      $('#desc-en').value = r.en; if (r.ml) $('#desc-ml').value = r.ml
    })
  })
  // Property quick fill: paste one paragraph, AI fills the editor fields (staff review, then save).
  var qfBtn = $('[data-ai-extract]')
  if (qfBtn) qfBtn.addEventListener('click', function () {
    var f = $('#prop-form'), st = $('#qf-status'), text = $('#qf-text').value.trim(), docIn = $('#qf-doc'), doc = docIn && docIn.files[0]
    if (text.length < 20 && !doc) { st.textContent = 'Paste a few lines about the property, or attach a PDF / Word file.'; return }
    var old = qfBtn.textContent; qfBtn.disabled = true; qfBtn.textContent = 'Reading… (up to a minute)'; st.textContent = ''
    var fd = new FormData(); fd.append('text', text); if (doc) fd.append('doc', doc)
    fetch(qfBtn.dataset.aiExtract, { method: 'POST', body: fd, headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (res) { return res.json() }).then(function (r) {
      qfBtn.disabled = false; qfBtn.textContent = old
      if (r.error) { st.textContent = r.error; return }
      $$('.qf-filled', f).forEach(function (el) { el.classList.remove('qf-filled') })
      var n = 0
      Object.keys(r.fields || {}).forEach(function (k) { if (fillField(f, k, r.fields[k])) n++ })
      var rooms = r.rooms || [], seasons = r.seasons || []
      // New property: put rooms straight into the room category blocks; otherwise they are added on save.
      var blocks = $('#new-rooms')
      if (blocks && rooms.length) {
        rooms.forEach(function (room, i) {
          var b = $$('.new-room', blocks)[i] || addRoomBlock()
          var idx = b.dataset.idx
          Object.keys(room).forEach(function (k) { fillField(f, 'nr' + idx + '_' + k, room[k]) })
        })
        $('#qf-rooms').value = ''
      } else $('#qf-rooms').value = rooms.length ? JSON.stringify(rooms) : ''
      $('#qf-seasons').value = seasons.length ? JSON.stringify(seasons) : ''
      var box = $('#qf-extra'), list = $('#qf-extra-list')
      if (rooms.length || seasons.length) {
        list.innerHTML = (rooms.length ? '<strong>Room categories found:</strong><ul>' + rooms.map(function (x) {
          return '<li>' + esc(x.name) + (x.units ? ' · ' + esc(x.units) + ' room(s)' : '') + (x.capacity ? ' · sleeps ' + esc(x.capacity) : '') + (x.base_rate ? ' · ' + money(+x.base_rate) : '') + (x.weekend_rate ? ' / ' + money(+x.weekend_rate) + ' wknd' : '') + '</li>'
        }).join('') + '</ul>' : '') + (seasons.length ? '<strong>Seasons found:</strong><ul>' + seasons.map(function (x) {
          return '<li>' + esc(x.name) + ' · ' + esc(x.start_date) + ' to ' + esc(x.end_date) + ' · ' + Object.keys(x.rates).map(function (k) { return esc(k) + ' ' + money(x.rates[k]) }).join(', ') + '</li>'
        }).join('') + '</ul>' : '')
        box.hidden = false
      } else box.hidden = true
      st.textContent = (n ? 'Filled ' + n + ' field(s) — highlighted in yellow. Please check them, then press Save.' : 'Could not find details to fill. Try adding more information.') + (r.warning ? ' ' + r.warning : '')
      var first = $('.qf-filled', f); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }).catch(function () { qfBtn.disabled = false; qfBtn.textContent = old; st.textContent = 'Something went wrong. Please try again.' })
  })
  function markFilled(el) { (el.closest('.field') || el.closest('label') || el).classList.add('qf-filled') }
  function fillField(f, k, v) {
    var els = $$('[name="' + k + '"]', f), touched = false
    els.forEach(function (el) {
      var hit = false
      if (el.type === 'file' || el.type === 'hidden') return
      if (el.type === 'checkbox') {
        if (Array.isArray(v)) { if (v.indexOf(el.value) >= 0 && !el.checked) { el.checked = true; hit = true } }
        else if (typeof v === 'boolean' && el.checked !== v) { el.checked = v; hit = true }
      } else if (el.tagName === 'SELECT') {
        if ($$('option', el).some(function (o) { return o.value === String(v) })) { el.value = String(v); hit = true }
      } else if ((typeof v === 'string' || typeof v === 'number') && v !== '') { el.value = String(v); hit = true }
      if (hit) { touched = true; markFilled(el); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
    })
    return touched
  }
  // ---------- Staff AI assistant ----------
  var asBox = $('[data-assistant]')
  if (asBox) (function () {
    var log = $('#as-log'), formEl = $('#as-form'), q = $('#as-q'), KEY = 'gs-assistant'
    var state = { history: [], need: null, turns: [] }
    try { state = JSON.parse(sessionStorage.getItem(KEY)) || state } catch (e) {}
    var save = function () { try { sessionStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {} }
    var fmt = function (t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/^\s*[-*•]\s+/gm, '• ') }
    var needForm = $('#as-need')
    function fillNeed() {
      var n = state.need
      if (!needForm || !n || n.intent === 'property_info') { if (needForm) needForm.hidden = true; return }
      needForm.hidden = false
      needForm.elements.destination.value = n.destination || ''
      needForm.elements.checkIn.value = n.checkIn || ''
      needForm.elements.checkOut.value = n.checkOut || ''
      needForm.elements.adults.value = n.adults || n.guests || ''
      needForm.elements.children.value = n.children || ''
      needForm.elements.priceMax.value = n.priceMax || ''
    }
    if (needForm) needForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var el = needForm.elements, n = Object.assign({}, state.need || {}, {
        destination: el.destination.value, checkIn: el.checkIn.value, checkOut: el.checkOut.value,
        adults: +el.adults.value || undefined, children: +el.children.value || 0, priceMax: +el.priceMax.value || undefined,
      })
      var label = [n.destination || 'Any destination', n.checkIn && n.checkOut ? n.checkIn + ' → ' + n.checkOut : '', n.adults ? (n.adults + (n.children || 0)) + ' guests' : '', n.priceMax ? 'max ' + money(n.priceMax) + '/room' : ''].filter(Boolean).join(' · ')
      ask('Updated: ' + label, n)
    })
    function card(o, d, best) {
      var qs = function (l) { return new URLSearchParams({ property: o.id, room: l.roomId, checkIn: d.checkIn, checkOut: d.checkOut, guests: l.count * l.capacity }).toString() }
      var main = o.lines.slice().sort(function (a, b) { return b.count * b.capacity - a.count * a.capacity })[0]
      return '<div class="card as-card' + (o.fits ? '' : ' as-nofit') + (best ? ' as-best' : '') + '">' + (best ? '<span class="pill pill-best">Best match</span>' : '') +
        '<div class="row-between"><strong><a href="/staff/rooms/' + o.id + '">' + esc(o.name) + '</a></strong><span class="muted small">' + esc(o.type) + ' · ' + esc(o.destination) + (o.rating ? ' · ★ ' + o.rating.toFixed(1) : '') + '</span></div>' +
        (o.fits ? '<ul class="small as-lines">' + o.lines.map(function (l) {
          return '<li>' + l.count + ' × ' + esc(l.room) + ' <span class="muted">(' + l.guests + ' guests' + (l.includedGuests < l.capacity ? '; rate covers ' + l.includedGuests + ', max ' + l.capacity + ' each' : '') + ')</span> — guest ' + money(l.guestPerNight) + '/night' +
            (l.extraGuests ? ' + <strong>' + l.extraGuests + ' extra guest' + (l.extraGuests > 1 ? 's' : '') + ' ' + money(l.extraCharge) + '</strong>' : '') +
            (l.staffPerNight ? ' · <span class="internal">staff ' + money(l.staffPerNight) + '</span>' : '') +
            (l.netPerNight ? ' · <span class="internal">net ' + money(l.netPerNight) + '</span>' : '') +
            (l.seasons.length ? ' <span class="pill pill-kind-special">' + esc(l.seasons.join(', ')) + '</span>' : '') + '</li>'
        }).join('') + '</ul>' : '<p class="small err">Not enough for the whole group — up to ' + o.maxSleeps + ' guests with the ' + o.freeRooms + ' free rooms.</p>') +
        (o.fits ? '<div class="as-totals"><span>Guest total <strong>' + money(o.guestTotal) + '</strong> <span class="muted small">incl. GST ' + money(o.gst) + '</span></span>' +
          (o.staffTotal ? '<span class="internal">Staff total ' + money(o.staffTotal) + '</span>' : '') +
          (o.netTotal ? '<span class="internal">Net total ' + money(o.netTotal) + '</span>' : '') + '</div>' : '') +
        (o.minNightsIssue ? '<p class="small err">' + esc(o.minNightsIssue) + '</p>' : '') +
        '<div class="row wrap-row">' + (o.fits && main ? '<a class="btn btn-sm" href="/staff/quotes/new?' + qs(main) + '">Start quote</a>' : '') +
        '<a class="btn btn-sm btn-outline" href="/staff/rooms/' + o.id + '">Rooms & photos</a><a class="btn btn-sm btn-outline" href="/stay/' + esc(o.slug) + '" target="_blank" rel="noopener">Guest page</a></div></div>'
    }
    function render(turn) {
      var h = '<div class="msg msg-staff">' + esc(turn.q) + '</div>'
      if (turn.error) return h + '<div class="msg msg-bot err">' + esc(turn.error) + '</div>'
      h += '<div class="msg msg-bot"><div class="as-answer">' + fmt(turn.answer || '') + '</div>'
      if (turn.dates) h += '<div class="muted small">' + turn.dates.guests + ' guests · ' + turn.dates.nights + ' night(s) · ' + turn.dates.checkIn + ' → ' + turn.dates.checkOut + (turn.dates.assumed ? ' (dates assumed)' : '') + '</div>'
      if (turn.options && turn.options.length) {
        var bestIdx = turn.options.findIndex(function (o) { return o.fits && !o.minNightsIssue })
        if (bestIdx < 0) bestIdx = turn.options.findIndex(function (o) { return o.fits })
        h += '<div class="as-cards">' + turn.options.map(function (o, i) { return card(o, turn.dates, i === bestIdx) }).join('') + '</div>'
      }
      return h + '</div>'
    }
    function draw() {
      var hint = $('.as-hint', log)
      $$('.msg', log).forEach(function (m) { m.remove() })
      if (hint) hint.hidden = state.turns.length > 0
      log.insertAdjacentHTML('beforeend', state.turns.map(render).join(''))
      var last = $$('.msg-staff', log).pop(); if (last) last.scrollIntoView({ block: 'start' })
      fillNeed()
    }
    function ask(text, edited) {
      var btn = $('button', formEl); btn.disabled = true; btn.textContent = 'Thinking…'
      var pending = { q: text, answer: 'Searching our properties and calculating prices…' }
      state.turns.push(pending); draw()
      fetch(asBox.dataset.assistant, { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(edited ? { q: text, history: state.history, need: edited, edited: true } : { q: text, history: state.history, need: state.need }) })
        .then(function (r) { return r.json() })
        .then(function (r) {
          state.turns.pop()
          if (r.error) state.turns.push({ q: text, error: r.error })
          else {
            state.turns.push({ q: text, answer: r.answer, dates: r.dates, options: r.options })
            state.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.answer })
            state.history = state.history.slice(-8); state.need = r.need
          }
          state.turns = state.turns.slice(-12); save(); draw()
        })
        .catch(function () { state.turns.pop(); state.turns.push({ q: text, error: 'Something went wrong. Please try again.' }); draw() })
        .then(function () { btn.disabled = false; btn.textContent = 'Ask' })
    }
    formEl.addEventListener('submit', function (e) { e.preventDefault(); var t = q.value.trim(); if (!t) return; q.value = ''; ask(t) })
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); formEl.requestSubmit() } })
    $$('[data-example]').forEach(function (b) { b.addEventListener('click', function () { ask(b.dataset.example) }) })
    $('[data-assistant-reset]').addEventListener('click', function () { state = { history: [], need: null, turns: [] }; save(); draw(); q.focus() })
    draw()
  })()

  // ---------- Admin property wizard ----------
  $$('[data-counter]').forEach(function (cnt) {
    var ta = cnt.previousElementSibling
    var upd = function () { cnt.textContent = ta.value.length + '/' + cnt.dataset.counter }
    if (ta) { ta.addEventListener('input', upd); upd() }
  })
  function nextIndex(sel, attr) { var m = -1; $$(sel).forEach(function (b) { var v = parseInt(b.getAttribute(attr), 10); if (v > m) m = v }); return m + 1 }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-add-kind]') : null
    if (!t) return
    e.preventDefault()
    var label = prompt('Name of the new item')
    if (!label) return
    var fd = new FormData(); fd.append('kind', t.dataset.addKind); fd.append('label', label)
    fetch('/admin/taxonomy/add', { method: 'POST', body: fd, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.json() }).then(function (r) {
      if (r.error) return alert(r.error)
      if (t.dataset.addSelect) { var s = document.getElementById(t.dataset.addSelect); var o = new Option(r.label, r.key, true, true); s.add(o) }
      if (t.dataset.addInput) { var inp = document.getElementById(t.dataset.addInput); inp.value = r.label; var dl = document.getElementById(inp.getAttribute('list')); if (dl) dl.appendChild(new Option(r.label)) }
      if (t.dataset.addTarget) {
        var wrap = t.closest('.tiles-wrap'), tiles = $('.tiles', wrap)
        tiles.insertAdjacentHTML('beforeend', '<label class="tile"><input type="checkbox" name="' + esc(t.dataset.addTarget) + '" value="' + esc(r.key) + '" checked><span class="tile-ico">' + esc(r.icon) + '</span><span>' + esc(r.label) + '</span></label>')
      }
    })
  })
  $$('[data-add-block]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.dataset.addBlock
      var tpl = document.getElementById(kind === 'room' ? 'room-block-tpl' : 'img-block-tpl')
      var list = document.getElementById(kind === 'room' ? 'room-blocks' : 'img-blocks')
      var i = kind === 'room' ? nextIndex('[data-room-block]', 'data-room-block') : $$('.img-block', list).length + 100
      list.insertAdjacentHTML('beforeend', tpl.innerHTML.replace(/__I__/g, String(i)))
      var last = list.lastElementChild; var h = $('h3', last); if (h && kind === 'img') h.textContent = 'Room Category ' + $$('.img-block', list).length
      var f = $('input:not([type=hidden]),select', last); if (f) f.focus()
      $$('[data-autosubmit]', last).forEach(autoSubmit)
    })
  })
  var roomSel = $('[data-room-select]')
  function showRoom(id) { $$('[data-rate-room]').forEach(function (p) { p.hidden = p.dataset.rateRoom !== String(id) }) }
  if (roomSel) {
    roomSel.addEventListener('change', function () { showRoom(roomSel.value) })
    var nx = $('[data-next-room]')
    if (nx) nx.addEventListener('click', function () {
      var i = roomSel.selectedIndex + 1
      if (i >= roomSel.options.length) { alert('All room categories are listed. Add more in Room Categories.'); return }
      roomSel.selectedIndex = i; showRoom(roomSel.value); roomSel.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
  $$('[data-add-peak]').forEach(function (b) {
    b.addEventListener('click', function () {
      var box = $('[data-peaks="' + b.dataset.addPeak + '"]'), row = box.lastElementChild.cloneNode(true)
      $$('input', row).forEach(function (i) { i.value = '' }); box.appendChild(row)
    })
  })
  function cloneClean(container, first) {
    var row = first.cloneNode(true)
    $$('input', row).forEach(function (i) { if (i.type === 'checkbox') i.checked = false; else if (i.type === 'hidden') i.value = '0'; else i.value = ''; i.required = false })
    $$('b', row).forEach(function (x) { x.remove() })
    container.appendChild(row)
  }
  var acts = $('[data-acts]')
  if (acts) {
    $('[data-add-activity]').addEventListener('click', function () { cloneClean(acts, acts.firstElementChild) })
    acts.addEventListener('click', function (e) {
      var d = e.target.closest('[data-del-row]'); if (!d) return
      var tr = d.closest('tr'); if (acts.children.length > 1) tr.remove(); else $$('input', tr).forEach(function (i) { if (i.type === 'checkbox') i.checked = false; else if (i.type !== 'hidden') i.value = '' })
    })
    acts.addEventListener('change', function (e) {
      var tr = e.target.closest('tr'); if (!tr) return
      if (e.target.classList.contains('act-free')) {
        $('input[name=act_free]', tr).value = e.target.checked ? '1' : '0'
        if (e.target.checked) { $('.act-charge', tr).checked = false; $('input[name=act_amt]', tr).value = '' }
      }
      if (e.target.classList.contains('act-charge') && e.target.checked) { $('.act-free', tr).checked = false; $('input[name=act_free]', tr).value = '0'; $('input[name=act_amt]', tr).focus() }
    })
  }
  var contacts = $('[data-contacts]')
  if (contacts) $('[data-add-contact]').addEventListener('click', function () { cloneClean(contacts, contacts.firstElementChild) })
  function autoSubmit(inp) { inp.addEventListener('change', function () { if (inp.files.length) inp.form.submit() }) }
  $$('[data-autosubmit]').forEach(autoSubmit)

  // Card carousels (home "Popular Stays")
  $$('[data-carousel]').forEach(function (car) {
    var track = $('.car-track', car)
    $$('[data-car]', car).forEach(function (b) {
      b.addEventListener('click', function () { track.scrollBy({ left: +b.dataset.car * track.clientWidth * 0.9, behavior: 'smooth' }) })
    })
  })

  // Share a link: phone share sheet when available, otherwise copy to clipboard
  $$('[data-share]').forEach(function (b) {
    b.addEventListener('click', function () {
      var url = b.dataset.share, old = b.textContent
      var done = function (msg) { b.textContent = msg; setTimeout(function () { b.textContent = old }, 1800) }
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) {
        navigator.share({ title: b.dataset.shareTitle || document.title, text: b.dataset.shareText || '', url: b.dataset.shareText ? undefined : url }).catch(function () {})
      } else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { done('Link copied ✓') }, function () { prompt('Copy this link', url) })
      else prompt('Copy this link', url)
    })
  })
  // New property: add more room category blocks
  var roomTpl = document.getElementById('new-room-tpl')
  function addRoomBlock() {
    var list = $('#new-rooms'), next = 0
    $$('.new-room', list).forEach(function (b) { next = Math.max(next, +b.dataset.idx + 1) })
    list.insertAdjacentHTML('beforeend', roomTpl.innerHTML.replace(/__IDX__/g, String(next)))
    return $$('.new-room', list).pop()
  }
  var addRoomBtn = $('[data-add-room]')
  if (addRoomBtn && roomTpl) addRoomBtn.addEventListener('click', function () { var b = addRoomBlock(); var i = $('input', b); if (i) i.focus() })
  var seoBtn = $('[data-ai-seo]')
  if (seoBtn) seoBtn.addEventListener('click', function () {
    var f = $('#prop-form'); seoBtn.disabled = true
    post(seoBtn.dataset.aiSeo, { name: f.elements.name.value, type: f.elements.type.value, destination: f.elements.destination.value, description: $('#desc-en').value }).then(function (r) {
      seoBtn.disabled = false
      if (r.error) return alert(r.error)
      $('#seo-title').value = r.title; $('#seo-desc').value = r.description
    })
  })
  $$('input[data-max]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var group = $$('input[name="' + cb.name + '"]:checked')
      if (group.length > +cb.dataset.max) { cb.checked = false; alert('Compare up to ' + cb.dataset.max + ' properties') }
    })
  })

  // ---------- Charts ----------
  function charts() {
    if (!window.Chart) return
    var green = '#137a70', palette = ['#137a70', '#6d4ae0', '#e6a700', '#c0392b', '#2e86de', '#8e44ad', '#16a085', '#d35400']
    var d = json('dash-data')
    if (d) {
      new Chart($('#ch-bookings'), { type: 'line', data: { labels: d.days, datasets: [{ label: 'Bookings', data: d.bookings, borderColor: green, backgroundColor: 'rgba(19,122,112,.12)', fill: true, tension: .3 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } })
      new Chart($('#ch-revenue'), { type: 'bar', data: { labels: d.revenueByProp.labels, datasets: [{ label: 'Revenue ₹', data: d.revenueByProp.values, backgroundColor: green }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } })
      new Chart($('#ch-sources'), { type: 'doughnut', data: { labels: d.sources.labels, datasets: [{ data: d.sources.values, backgroundColor: palette }] } })
    }
    var r = json('report-data')
    if (r) new Chart($('#ch-report'), { data: { labels: r.labels, datasets: [{ type: 'bar', label: 'Bookings', data: r.bookings, backgroundColor: green, yAxisID: 'y' }, { type: 'line', label: 'Revenue ₹', data: r.revenue, borderColor: '#6d4ae0', yAxisID: 'y1' }] }, options: { scales: { y: { beginAtZero: true, position: 'left' }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } } })
    var a = json('ask-data')
    if (a) new Chart($('#ch-ask'), { type: 'bar', data: { labels: a.labels, datasets: [{ label: a.label, data: a.values, backgroundColor: green }] }, options: { plugins: { legend: { display: false } } } })
  }

})()

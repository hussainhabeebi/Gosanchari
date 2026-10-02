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

  // ---------- Gallery lightbox ----------
  var gal = $('[data-gallery]')
  if (gal) {
    var links = $$('[data-full]', gal)
    var idx = 0
    var box
    function show(i) {
      idx = (i + links.length) % links.length
      if (!box) {
        box = document.createElement('div')
        box.className = 'lightbox'
        box.innerHTML = '<img alt=""><button class="lb-close" aria-label="Close">×</button><button class="lb-prev" aria-label="Previous">‹</button><button class="lb-next" aria-label="Next">›</button>'
        document.body.appendChild(box)
        box.addEventListener('click', function (e) {
          if (e.target.classList.contains('lb-prev')) show(idx - 1)
          else if (e.target.classList.contains('lb-next')) show(idx + 1)
          else if (e.target.tagName !== 'IMG') { box.remove(); box = null }
        })
        document.addEventListener('keydown', function (e) {
          if (!box) return
          if (e.key === 'Escape') { box.remove(); box = null }
          if (e.key === 'ArrowLeft') show(idx - 1)
          if (e.key === 'ArrowRight') show(idx + 1)
        })
      }
      $('img', box).src = links[idx].href
    }
    links.forEach(function (a, i) { a.addEventListener('click', function (e) { e.preventDefault(); show(i) }) })
    var all = $('[data-open-gallery]', gal)
    if (all) all.addEventListener('click', function () { show(0) })
  }

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
        post(bf.dataset.priceUrl, { room: fd.get('room'), checkIn: fd.get('check_in'), checkOut: fd.get('check_out'), rooms: fd.get('rooms') }).then(function (p) {
          if (p.errors && p.errors.length) { box2.innerHTML = '<span class="error small">' + esc(p.errors[0]) + '</span>'; return }
          box2.innerHTML = '<div class="muted small">Estimated price (confirmed in your quote)</div><table class="breakdown"><tr><td>' + p.nights + ' night' + (p.nights > 1 ? 's' : '') + ' × ' + p.roomsCount + ' room' + (p.roomsCount > 1 ? 's' : '') + '</td><td>' + money(p.subtotal) + '</td></tr>' +
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

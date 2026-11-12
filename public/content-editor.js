// Admin content editing: property FAQ rows (add/remove) and the blog rich-text editor.
// Loaded only on the property Add/Edit pages and the blog editor (not part of app.js).

// Property SEO Details: repeatable FAQ rows (question + answer) with add / remove.
(function () {
  'use strict'
  document.querySelectorAll('[data-faq-editor]').forEach(function (box) {
    var list = box.querySelector('[data-faq-list]'), tpl = box.querySelector('[data-faq-template]'), add = box.querySelector('[data-faq-add]')
    var max = parseInt(box.getAttribute('data-faq-max'), 10) || 20
    if (!list || !tpl || !add) return
    function sync() { add.hidden = list.querySelectorAll('[data-faq-row]').length >= max }
    add.addEventListener('click', function () {
      if (list.querySelectorAll('[data-faq-row]').length >= max) return
      list.appendChild(tpl.content.cloneNode(true))
      var rows = list.querySelectorAll('[data-faq-row]'), input = rows[rows.length - 1].querySelector('input')
      if (input) input.focus()
      sync()
    })
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-faq-remove]')
      if (!btn) return
      var row = btn.closest('[data-faq-row]')
      if (row) row.remove()
      sync()
      add.focus()
    })
    sync()
  })
})();

// Blog: small rich-text editor (no library). The server sanitizes whatever is submitted (src/lib/sanitize.ts);
// without JavaScript the plain HTML textarea is used instead.
(function () {
  'use strict'
  document.querySelectorAll('[data-rich-editor]').forEach(function (box) {
    var area = box.querySelector('[data-rich-area]'), source = box.querySelector('[data-rich-source]')
    var picker = box.querySelector('[data-rich-image]'), status = box.querySelector('[data-rich-status]')
    if (!area || !source || !document.execCommand) return
    area.hidden = false
    source.hidden = true
    try { document.execCommand('defaultParagraphSeparator', false, 'p') } catch (e) { /* older browsers */ }
    if (!area.innerHTML.trim()) area.innerHTML = '<p><br></p>'
    function sync() { source.value = area.innerHTML }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
    var saved = null
    function keep() { var s = window.getSelection(); if (s && s.rangeCount && area.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange() }
    function restore() { area.focus(); if (saved) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(saved) } }
    area.addEventListener('keyup', keep); area.addEventListener('mouseup', keep); area.addEventListener('input', function () { keep(); sync() })
    area.addEventListener('paste', function (e) {
      // Pasted text keeps its paragraphs but not its original formatting.
      var text = (e.clipboardData || window.clipboardData).getData('text/plain')
      if (text == null) return
      e.preventDefault()
      var html = text.split(/\n{2,}/).map(function (para) { return '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>' }).join('')
      document.execCommand('insertHTML', false, html)
      sync()
    })
    box.querySelectorAll('[data-cmd]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault() })
      btn.addEventListener('click', function () {
        var cmd = btn.getAttribute('data-cmd'), arg = null
        restore()
        if (cmd.indexOf('formatBlock:') === 0) { arg = '<' + cmd.slice(12) + '>'; cmd = 'formatBlock' }
        if (cmd === 'link') {
          var url = window.prompt('Link address (https://… or /page):', 'https://')
          if (!url || url === 'https://') return
          if (!/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(url)) { window.alert('Use a link that starts with https://, http://, mailto:, tel: or /'); return }
          cmd = 'createLink'; arg = url
        }
        if (cmd === 'image') { picker.value = ''; picker.click(); return }
        document.execCommand(cmd, false, arg)
        keep(); sync()
      })
    })
    picker && picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0]
      if (!file) return
      var alt = window.prompt('Describe this image (alt text):', '') || ''
      var data = new FormData(); data.append('image', file)
      if (status) status.textContent = 'Uploading image…'
      fetch(box.getAttribute('data-upload-url'), { method: 'POST', body: data, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); return j }) })
        .then(function (j) {
          restore()
          document.execCommand('insertHTML', false, '<p><img src="' + esc(j.url) + '" alt="' + esc(alt) + '"></p>')
          sync()
          if (status) status.textContent = 'Image added.'
        })
        .catch(function (err) { if (status) status.textContent = err.message || 'Upload failed.' })
    })
    var formEl = box.closest('form')
    if (formEl) formEl.addEventListener('submit', sync)
  })
  // Suggest a slug from the title until the slug is edited by hand.
  document.querySelectorAll('[data-blog-form]').forEach(function (f) {
    var title = f.querySelector('[data-blog-title]'), slug = f.querySelector('[data-blog-slug]')
    if (!title || !slug || slug.value) return
    var touched = false
    slug.addEventListener('input', function () { touched = true })
    title.addEventListener('input', function () {
      if (touched) return
      slug.value = title.value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    })
  })
})();

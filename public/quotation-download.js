// Quotation print-page enhancement only. Exports rendered, already-calculated values.
(function () {
  'use strict';
  var button = document.querySelector('[data-download-quote]');
  var content = document.querySelector('[data-quote-export]');
  var status = document.querySelector('[data-pdf-status]');
  if (!button || !content || !status) return;
  button.addEventListener('click', function () {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Preparing PDF…';
    status.textContent = '';
    Promise.resolve().then(function () {
      if (typeof window.html2pdf !== 'function') throw new Error('PDF exporter did not load.');
      // Bound canvas memory on mobile instead of risking an empty oversized PDF.
      if (content.scrollHeight > 12000) throw new Error('Quotation is too long for this export.');
      var exportContent = content.cloneNode(true);
      // Individual policy lines can break between pages without slicing a line.
      exportContent.querySelectorAll('p[style*="pre-line"]').forEach(function (paragraph) {
        var lines = paragraph.textContent.split('\n');
        paragraph.textContent = '';
        lines.forEach(function (line) {
          var row = document.createElement('span');
          row.className = 'pdf-policy-line';
          row.style.display = 'block';
          row.style.minHeight = '1.5em';
          row.textContent = line;
          paragraph.appendChild(row);
        });
      });
      var code = (button.getAttribute('data-quote-code') || 'Quotation').replace(/[^A-Za-z0-9_-]/g, '_');
      return window.html2pdf().set({
        filename: 'Quotation-' + code + '.pdf',
        margin: 12,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1, windowWidth: 800, scrollX: 0, scrollY: 0, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'h1', 'h2', 'h3', '.pdf-policy-line'] }
      }).from(exportContent).save();
    }).then(function () {
      status.textContent = 'PDF prepared. Check your browser downloads.';
    }).catch(function () {
      status.textContent = 'Could not prepare the PDF. Please try again or use Print.';
    }).finally(function () {
      button.disabled = false;
      button.textContent = '⬇ Download PDF';
    });
  });
})();

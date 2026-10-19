/* Consent-first GA4. No Google requests until opt-in; page categories contain no user input. */
(() => {
  'use strict';
  const root = document.getElementById('public-analytics');
  if (!root || window.__gsAnalytics) return;
  window.__gsAnalytics = true;
  const id = 'G-J5JVRNNVKL';
  const paths = ['/', '/search', '/offers', '/about', '/contact', '/policies/privacy', '/policies/terms', '/policies/cancellation', '/stay/property'];
  const path = root.dataset.page;
  if (location.origin !== 'https://gosanchari.com' || !paths.includes(path)) return;
  const key = 'gs-analytics-consent-v1';
  const consentCookie = 'gs_analytics_consent';
  const panel = root.querySelector('[data-consent-panel]');
  const preferences = root.querySelector('[data-consent-settings]');
  let loaded = false;
  let withdrawn = false;
  let tag;
  const queued = [];
  let choice;
  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  panel.appendChild(notice);
  function cookieValue() {
    return document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(consentCookie + '='))?.slice(consentCookie.length + 1);
  }
  function persist(record) {
    // Rotate a verification marker even on restoration; writing an unchanged value
    // cannot detect browsers that silently refuse writes. This is not a user identifier.
    const next = { value: record.value, at: record.at, check: Math.random().toString(36).slice(2) };
    const raw = JSON.stringify(next);
    const marker = next.value + '.' + next.at + '.' + next.check;
    let localOK = false, cookieOK = false;
    // Attempt both independently: rejection in either store invalidates an old acceptance.
    try {
      localStorage.setItem(key, raw);
      localOK = localStorage.getItem(key) === raw;
    } catch (_) {}
    try {
      document.cookie = consentCookie + '=' + marker + '; Max-Age=15552000; Path=/; SameSite=Lax; Secure';
      cookieOK = cookieValue() === marker;
    } catch (_) {}
    return localOK && cookieOK;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    const age = Date.now() - stored?.at;
    if (stored && Number.isFinite(stored.at) && age >= 0 && age < 180 * 86400000 &&
        ['accepted', 'rejected'].includes(stored.value)) {
      // Reusing consent requires matching, writable stores. Never trust stale read-only acceptance.
      const matched = typeof stored.check === 'string' && cookieValue() === stored.value + '.' + stored.at + '.' + stored.check;
      if (matched && persist(stored)) choice = stored.value;
    }
  } catch (_) { /* Storage unavailable: default to no tracking. */ }
  function start() {
    if (loaded || withdrawn) return;
    loaded = true;
    window['ga-disable-' + id] = false;
    window.dataLayer = window.dataLayer || [];
    function gtag() { queued.push(arguments); window.dataLayer.push(arguments); }
    gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gtag('js', new Date());
    const safe = { page_location: 'https://gosanchari.com' + path, page_title: path === '/' ? 'Home' : path.slice(1), page_referrer: '' };
    gtag('config', id, Object.assign({}, safe, {
      send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
      cookie_flags: 'SameSite=Lax;Secure', cookie_expires: 15552000, cookie_update: false,
    }));
    gtag('event', 'page_view', Object.assign({ send_to: id }, safe));
    tag = document.createElement('script');
    tag.async = true;
    tag.referrerPolicy = 'no-referrer';
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    document.head.appendChild(tag);
  }
  function stop() {
    // This must happen before any storage access, including when every write fails.
    withdrawn = true;
    window['ga-disable-' + id] = true;
    tag?.remove();
    // A slow-loading tag must not later consume our previously queued consent/config/events.
    if (window.dataLayer) for (let i = window.dataLayer.length - 1; i >= 0; i--) {
      if (queued.includes(window.dataLayer[i])) window.dataLayer.splice(i, 1);
    }
    try {
      for (const cookie of document.cookie.split(';')) {
        const name = cookie.trim().split('=')[0];
        if (!/^_ga(?:_|$)/.test(name)) continue;
        for (const domain of ['', '; Domain=gosanchari.com', '; Domain=.gosanchari.com']) {
          document.cookie = name + '=; Max-Age=0; Path=/' + domain + '; SameSite=Lax; Secure';
        }
      }
    } catch (_) { /* Collection remains disabled even when cookie access fails. */ }
  }
  function choose(value) {
    if (value === 'rejected') stop();
    const saved = persist({ value, at: Date.now() });
    if (!saved) {
      stop();
      panel.hidden = false;
      notice.textContent = 'Analytics is off. Your preference could not be saved; tracking will remain off while consent storage is unavailable.';
      return;
    }
    // Never reload after withdrawal, whether persistence succeeded or failed.
    panel.hidden = false;
    if (value === 'accepted' && withdrawn) {
      notice.textContent = 'Analytics remains off on this page. Your choice is saved for your next visit.';
      return;
    }
    notice.textContent = '';
    panel.hidden = true;
    if (value === 'accepted') start();
    preferences.focus();
  }
  root.querySelector('[data-consent-accept]').addEventListener('click', () => choose('accepted'));
  root.querySelector('[data-consent-reject]').addEventListener('click', () => choose('rejected'));
  preferences.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) root.querySelector('[data-consent-reject]').focus();
  });
  panel.hidden = choice === 'accepted' || choice === 'rejected';
  if (choice === 'accepted') start();
})();

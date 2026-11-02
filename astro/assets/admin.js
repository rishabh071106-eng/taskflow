// Jyotish admin (/astro/admin.html): the owner verifies pandits who joined, adds pandits they know, and confirms
// bookings by assigning a verified pandit (the family and the pandit get a notification). Admin = isAdminUser on the server.
(function () {
  'use strict';
  const { t, esc, ic } = AX, main = document.getElementById('main'), PR = window.AstroPrice;
  bdTopbar({ back: '/astro/', backLabel: t('Jyotish', 'ज्योतिष'), title: t('Bookings admin', 'बुकिंग एडमिन') });
  let D = null, A = null, tab = 'bookings';
  const name = (list, id) => { const x = (list || []).find(a => a.id === id); return x ? AX.name(x) : id; };
  const head = '<header class="ui-page-h"><h1>' + esc(t('Bookings admin', 'बुकिंग एडमिन')) + '</h1></header>';

  function draw() {
    if (!A) return;
    const open = A.bookings.filter(b => b.status === 'requested').length, pend = A.pandits.filter(p => p.status === 'pending').length;
    let h = head + '<div class="ui-seg" style="display:flex;margin-bottom:14px">' + [['bookings', t('Bookings', 'बुकिंग') + (open ? ' (' + open + ')' : '')], ['pandits', t('Pandits', 'पंडित') + (pend ? ' (' + pend + ')' : '')], ['add', t('Add pandit', 'पंडित जोड़ें')]]
      .map(([k, l]) => '<button type="button" style="flex:1" data-tab="' + k + '" aria-pressed="' + (tab === k) + '"' + (tab === k ? ' class="on"' : '') + '>' + esc(l) + '</button>').join('') + '</div>';
    if (tab === 'bookings') h += A.bookings.length ? A.bookings.map(b => {
      const verified = A.pandits.filter(p => p.status === 'verified' && p.city === b.city);
      const fit = verified.filter(p => p.pujas.includes(b.puja)), others = verified.filter(p => !p.pujas.includes(b.puja));
      return '<section class="ax-card" data-b="' + esc(b.id) + '"><div style="display:flex;justify-content:space-between;gap:10px"><div><h3>' + esc(name(D.pujas, b.puja)) + '</h3><p class="ax-muted">' + esc(b.id + ' · ' + AX.fmtDate(b.date) + ' · ' + b.time + ' · ' + name(D.cities, b.city)) + '</p></div><span class="ax-pill ' + b.status + '">' + esc(b.status) + '</span></div>'
        + '<p class="ax-body" style="margin-top:6px">' + esc(name(D.packages ? Object.keys(D.packages).map(k => Object.assign({ id: k }, D.packages[k])) : [], b.pkg) + ' · ' + AX.rupees(b.price)) + '</p>'
        + '<p class="ax-body">' + esc(b.contact_name) + ' · <a href="tel:' + esc(b.contact_phone) + '">' + esc(b.contact_phone) + '</a>' + (b.lang ? ' · ' + esc(name(D.langs, b.lang)) : '') + (b.tradition ? ' · ' + esc(name(D.traditions, b.tradition)) : '') + '</p>'
        + (b.address ? '<p class="ax-small">' + esc(b.address) + '</p>' : '') + (b.notes ? '<p class="ax-small">' + esc(b.notes) + '</p>' : '')
        + '<div class="ax-form" style="margin-top:10px"><label>' + esc(t('Pandit', 'पंडित')) + '<select class="ui-field" data-f="pandit_id"><option value="">' + esc(t('Not assigned', 'तय नहीं')) + '</option>'
        + fit.map(p => '<option value="' + p.id + '"' + (b.pandit_id === p.id ? ' selected' : '') + '>' + esc(p.name + ' · ' + p.phone) + '</option>').join('')
        + (others.length ? '<optgroup label="' + esc(t('In this city, puja not listed', 'इस शहर में, पूजा सूची में नहीं')) + '">' + others.map(p => '<option value="' + p.id + '"' + (b.pandit_id === p.id ? ' selected' : '') + '>' + esc(p.name + ' · ' + p.phone) + '</option>').join('') + '</optgroup>' : '')
        + '</select></label><label>' + esc(t('Note to the family (optional)', 'परिवार के लिए नोट (ज़रूरी नहीं)')) + '<input class="ui-field" data-f="note" maxlength="300" value="' + esc(b.admin_note || '') + '"></label>'
        + '<div class="ax-row-btns" style="margin-top:0">' + ['confirmed', 'done', 'cancelled'].map(s => '<button type="button" class="ui-btn sm ' + (s === 'confirmed' ? 'accent' : 'sec') + '" data-set="' + s + '">' + esc({ confirmed: t('Confirm', 'पक्का करें'), done: t('Mark done', 'पूरी हुई'), cancelled: t('Cancel', 'रद्द करें') }[s]) + '</button>').join('') + '</div></div></section>';
    }).join('') : '<p class="tk-none">' + esc(t('No bookings yet.', 'अभी कोई बुकिंग नहीं।')) + '</p>';
    if (tab === 'pandits') h += A.pandits.length ? A.pandits.map(p => '<section class="ax-card"><div style="display:flex;justify-content:space-between;gap:10px"><div><h3>' + esc(p.name) + '</h3><p class="ax-muted">' + esc(name(D.cities, p.city) + ' · ' + p.phone + (p.experience ? ' · ' + p.experience + t(' yrs', ' वर्ष') : '') + ' · ' + (p.added_by === 'admin' ? t('added by you', 'आपने जोड़ा') : t('joined', 'ख़ुद जुड़े'))) + '</p></div><span class="ax-pill ' + p.status + '">' + esc(p.status) + '</span></div>'
      + '<p class="ax-small" style="margin-top:6px">' + esc(p.langs.map(l => name(D.langs, l)).join(', ') + ' · ' + p.traditions.map(l => name(D.traditions, l)).join(', ')) + '</p><p class="ax-body">' + esc(p.pujas.map(x => name(D.pujas, x)).join(', ')) + '</p>' + (p.about ? '<p class="ax-small">' + esc(p.about) + '</p>' : '')
      + '<div class="ax-row-btns">' + ['verified', 'paused', 'rejected'].filter(s => s !== p.status).map(s => '<button type="button" class="ui-btn sm ' + (s === 'verified' ? 'accent' : 'sec') + '" data-p="' + esc(p.id) + '" data-s="' + s + '">' + esc({ verified: t('Verify', 'सत्यापित करें'), paused: t('Pause', 'रोकें'), rejected: t('Reject', 'अस्वीकार') }[s]) + '</button>').join('') + '</div></section>').join('')
      : '<p class="tk-none">' + esc(t('No pandits yet. Add the pandits you know, or share the Join link.', 'अभी कोई पंडित नहीं। जिन्हें जानते हैं उन्हें जोड़ें, या जुड़ने का लिंक शेयर करें।')) + '</p>';
    if (tab === 'add') h += '<form class="ax-form ax-card" id="af" novalidate><label>' + esc(t('Name', 'नाम')) + '<input class="ui-field" name="name" maxlength="60"></label>'
      + '<label>' + esc(t('Phone', 'फ़ोन')) + '<input class="ui-field" type="tel" name="phone" maxlength="16" placeholder="+91"></label>'
      + '<div class="ax-two"><label>' + esc(t('City', 'शहर')) + '<select class="ui-field" name="city">' + D.cities.map(c => '<option value="' + c.id + '">' + esc(AX.name(c)) + '</option>').join('') + '</select></label>'
      + '<label>' + esc(t('Years', 'वर्ष')) + '<input class="ui-field" name="experience" inputmode="numeric" maxlength="2"></label></div>'
      + '<label>' + esc(t('Languages', 'भाषाएँ')) + '</label><div class="ax-chips wrap" data-multi="langs">' + D.langs.map(l => '<button type="button" class="ax-chip' + (l.id === 'hi' || l.id === 'sa' ? ' on' : '') + '" data-v="' + l.id + '">' + esc(AX.name(l)) + '</button>').join('') + '</div>'
      + '<label>' + esc(t('Traditions', 'परंपराएँ')) + '</label><div class="ax-chips wrap" data-multi="traditions">' + D.traditions.map(l => '<button type="button" class="ax-chip" data-v="' + l.id + '">' + esc(AX.name(l)) + '</button>').join('') + '</div>'
      + '<label>' + esc(t('Pujas', 'पूजाएँ')) + '</label><div class="ax-chips wrap" data-multi="pujas">' + D.pujas.map(l => '<button type="button" class="ax-chip" data-v="' + l.id + '">' + esc(AX.name(l)) + '</button>').join('') + '</div>'
      + '<label>' + esc(t('About', 'परिचय')) + '<textarea class="ui-field" name="about" rows="2" maxlength="400"></textarea></label>'
      + '<button class="ui-btn accent wide" type="submit">' + esc(t('Add as verified', 'सत्यापित के रूप में जोड़ें')) + '</button></form>';
    main.innerHTML = h;
    main.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    main.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', async () => {
      const card = b.closest('[data-b]'), body = { status: b.dataset.set, pandit_id: card.querySelector('[data-f="pandit_id"]').value, note: card.querySelector('[data-f="note"]').value };
      try { await AX.api('/api/astro/admin/bookings/' + encodeURIComponent(card.dataset.b), { body }); AX.toast(t('Saved', 'सेव हो गया')); load(); }
      catch (e) { AX.toast((e.body && e.body.error) || t('Could not save', 'सेव नहीं हुआ')); }
    }));
    main.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', async () => {
      try { await AX.api('/api/astro/admin/pandits/' + encodeURIComponent(b.dataset.p), { body: { status: b.dataset.s } }); load(); }
      catch (e) { AX.toast((e.body && e.body.error) || t('Could not save', 'सेव नहीं हुआ')); }
    }));
    main.querySelectorAll('[data-multi] [data-v]').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
    const af = document.getElementById('af');
    if (af) af.addEventListener('submit', async e => {
      e.preventDefault();
      const pick = n => [...af.querySelectorAll('[data-multi="' + n + '"] .on')].map(b => b.dataset.v);
      try { await AX.api('/api/astro/admin/pandits', { body: { name: af.name.value, phone: af.phone.value, city: af.city.value, experience: af.experience.value, about: af.about.value, langs: pick('langs'), traditions: pick('traditions'), pujas: pick('pujas') } }); AX.toast(t('Pandit added', 'पंडित जुड़ गए')); tab = 'pandits'; load(); }
      catch (x) { AX.toast((x.body && x.body.error) || t('Could not add', 'जोड़ा नहीं जा सका')); }
    });
  }
  function load() {
    AX.api('/api/astro/admin').then(r => { A = r; draw(); }).catch(e => {
      main.innerHTML = head + '<p class="tk-none">' + esc(e.status === 403 ? t('This page is for the Brodoit admin.', 'यह पेज Brodoit एडमिन के लिए है।') : e.status === 401 ? t('Sign in first.', 'पहले साइन इन करें।') : t('Could not load.', 'लोड नहीं हुआ।')) + '</p>';
    });
  }
  main.innerHTML = head + '<i class="ui-skel" style="height:200px"></i>';
  AX.data().then(d => { D = d; load(); });
})();

/* ANOX — platform UI.
 * One UI, two backends: the real server (account mode) or the in-memory demo backend (demo.js).
 * All metrics are computed from per-activity rows, so every number can be traced to its source.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- constants
  const POS = { GK: 'שוער', DEF: 'הגנה', MID: 'קישור', FWD: 'התקפה' };
  const KIND = { training: 'אימון', match: 'משחק' };
  const SOURCE = { demo: 'הדגמה', manual: 'הזנה ידנית', csv: 'ייבוא CSV', device: 'מכשיר' };
  const PLAN = { pilot: 'פיילוט', trial: 'ניסיון', paid: 'מנוי בתשלום' };
  const TEAM_STATUS = { active: 'פעילה', suspended: 'מושהית' };
  const AUDIT = {
    login: 'התחברות', 'password.change': 'שינוי סיסמה', 'team.create': 'יצירת קבוצה', 'team.update': 'עדכון קבוצה',
    'user.create': 'יצירת מנהל', 'user.update': 'עדכון משתמש', 'user.password_reset': 'איפוס סיסמה',
    'player.create': 'הוספת שחקן', 'player.update': 'עדכון שחקן', 'activity.create': 'הזנת פעילות',
    'activity.update': 'עדכון פעילות', 'activity.delete': 'מחיקת פעילות', 'import.csv': 'ייבוא CSV',
    'import.undo': 'ביטול ייבוא', 'device.create': 'הוספת מכשיר', 'device.assign': 'שיוך מכשיר',
    'owner.create': 'יצירת מנהל פלטפורמה', 'demo.seed': 'יצירת נתוני הדגמה',
  };

  // ------------------------------------------------------------- utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (d) => new Intl.NumberFormat('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : nf(d).format(v));
  const iso = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const fdate = (s) => { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
  const fdatetime = (s) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const store = {
    get(k) { try { return localStorage.getItem('anox.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('anox.' + k, v); } catch (e) { /* storage unavailable */ } },
  };
  const srcBadge = (s) => `<span class="badge badge--${esc(s)}">${esc(SOURCE[s] || s)}</span>`;
  const kindBadge = (k) => `<span class="badge ${k === 'match' ? 'badge--match' : ''}">${esc(KIND[k] || k)}</span>`;
  const posTag = (p) => `<span class="pos">${esc(POS[p] || p)}</span>`;
  const jersey = (n) => `<span class="jersey num">${n == null ? '–' : esc(n)}</span>`;
  const errMsg = (e) => (e && (e.error || e.message)) || 'שגיאה';

  // ------------------------------------------------------------- backends
  const remote = {
    mode: 'account',
    async request(method, url, body) {
      const res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-ANOX-Request': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty */ }
      if (!res.ok) throw Object.assign(new Error(data.error || 'שגיאה'), { status: res.status, error: data.error, details: data.details });
      return data;
    },
  };

  // ------------------------------------------------------------- state
  const state = {
    backend: null, me: null, teams: [], teamId: null, period: store.get('period') || '30',
    raw: null, // { team, players, activities, devices }
    rosterSort: { key: 'number', dir: 1 }, rosterQuery: '', rosterPos: '', rosterArchived: false,
    compare: [], openActivity: null, importPlan: null, importPayload: null,
  };
  const api = (m, u, b) => state.backend.request(m, u, b);
  const isOwner = () => state.me && state.me.user.role === 'owner';
  const team = () => state.teams.find((t) => t.id === state.teamId);

  function periodBounds() {
    if (state.period === 'all') return { from: null, prevFrom: null };
    const days = +state.period;
    const from = addDays(today(), -(days - 1));
    return { from, prevFrom: addDays(from, -days) };
  }

  // derived, period-aware view of the loaded data
  function view() {
    const { from, prevFrom } = periodBounds();
    const acts = state.raw ? state.raw.activities : [];
    return {
      players: state.raw ? state.raw.players : [],
      current: from ? acts.filter((a) => a.date >= from) : acts,
      previous: from ? acts.filter((a) => a.date >= prevFrom && a.date < from) : [],
    };
  }

  // ------------------------------------------------------------- stats
  function rows(activities, playerId) {
    const out = [];
    for (const a of activities) for (const m of a.metrics) if (playerId == null || m.player_id === playerId) out.push({ a, m });
    return out;
  }
  function statsOf(list) {
    const dist = list.map((r) => r.m.distance_km).filter((v) => v != null);
    const speed = list.map((r) => r.m.max_speed_kmh).filter((v) => v != null);
    const spr = list.map((r) => r.m.sprints).filter((v) => v != null);
    const mins = list.map((r) => r.m.minutes).filter((v) => v != null);
    const both = list.filter((r) => r.m.distance_km != null && r.m.minutes);
    const bothMin = sum(both.map((r) => r.m.minutes));
    return {
      sessions: list.length,
      distTotal: dist.length ? sum(dist) : null,
      distAvg: avg(dist),
      speedMax: speed.length ? Math.max(...speed) : null,
      speedAvg: avg(speed),
      sprintAvg: avg(spr),
      sprintN: spr.length,
      minutes: mins.length ? sum(mins) : null,
      intensity: bothMin ? (sum(both.map((r) => r.m.distance_km)) * 1000) / bothMin : null, // m/min
      sources: [...new Set(list.map((r) => r.a.source))],
    };
  }
  function perPlayer(players, activities) {
    const map = new Map(players.map((p) => [p.id, []]));
    for (const a of activities) for (const m of a.metrics) if (map.has(m.player_id)) map.get(m.player_id).push({ a, m });
    const out = new Map();
    for (const [id, list] of map) out.set(id, statsOf(list));
    return out;
  }
  function delta(cur, prev) {
    if (cur == null || prev == null || !prev) return '';
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) < 0.5) return '<div class="kpi__hint">ללא שינוי לעומת התקופה הקודמת</div>';
    return `<div class="kpi__hint">${pct > 0 ? '▲' : '▼'} <span class="num">${fmt(Math.abs(pct), 0)}%</span> לעומת התקופה הקודמת</div>`;
  }
  function sourceStrip(activities) {
    const counts = {};
    activities.forEach((a) => { counts[a.source] = (counts[a.source] || 0) + 1; });
    const keys = Object.keys(SOURCE).filter((k) => counts[k]);
    if (!keys.length) return '';
    return `<div class="source-strip">מקור הנתונים בתקופה: ${keys.map((k) => `${srcBadge(k)} <span class="num">${counts[k]}</span>`).join(' ')}</div>`;
  }

  // ------------------------------------------------------------- charts
  function barChart(points, { unit = '', height = 220, width = 720 } = {}) {
    // points: [{label, value, kind}] — chronological, left→right
    if (!points.length) return '<p class="empty">אין נתונים בתקופה שנבחרה</p>';
    const W = width, H = height, padL = 36, padB = 26, padT = 10, padR = 8;
    const max = Math.max(...points.map((p) => p.value || 0)) * 1.12 || 1;
    const bw = (W - padL - padR) / points.length;
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const mean = avg(points.map((p) => p.value).filter((v) => v != null));
    const ticks = [0, max / 2, max].map((t) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, max < 10 ? 1 : 0)}</text>`).join('');
    const every = Math.ceil(points.length / (W / 90));
    const bars = points.map((p, i) => {
      const x = padL + i * bw + bw * 0.15, w = bw * 0.7, v = p.value || 0;
      const lbl = i % every === 0 ? `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>` : '';
      return `<rect class="bar-${p.kind || 'training'}" x="${x}" y="${y(v)}" width="${w}" height="${Math.max(0, y(0) - y(v))}" rx="2"><title>${esc(p.title || p.label)}: ${fmt(v, 2)} ${esc(unit)}</title></rect>${lbl}`;
    }).join('');
    const meanLine = mean != null ? `<line class="avg-line" x1="${padL}" x2="${W - padR}" y1="${y(mean)}" y2="${y(mean)}"/>` : '';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" direction="ltr" role="img">${ticks}${bars}${meanLine}</svg>`;
  }
  function lineChart(points, { unit = '', height = 200, width = 720 } = {}) {
    const vals = points.filter((p) => p.value != null);
    if (vals.length < 2) return '<p class="empty">נדרשות לפחות שתי פעילויות להצגת מגמה</p>';
    const W = width, H = height, padL = 36, padB = 26, padT = 12, padR = 12;
    const vs = vals.map((p) => p.value);
    const lo = Math.min(...vs) * 0.9, hi = Math.max(...vs) * 1.08;
    const x = (i) => padL + ((W - padL - padR) * i) / (vals.length - 1);
    const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo || 1));
    const ticks = [lo, (lo + hi) / 2, hi].map((t) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, 1)}</text>`).join('');
    const path = vals.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const every = Math.ceil(vals.length / (W / 90));
    const dots = vals.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="3.5"><title>${esc(p.title || p.label)}: ${fmt(p.value, 2)} ${esc(unit)}</title></circle>${i % every === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>` : ''}`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" direction="ltr" role="img">${ticks}<path class="line" d="${path}"/>${dots}</svg>`;
  }
  function hbars(items, unit, digits = 1) {
    if (!items.length) return '<p class="empty">אין נתונים</p>';
    const max = Math.max(...items.map((i) => i.value)) || 1;
    return `<div class="hbars">${items.map((i) => `
      <div class="hbar"><a class="player-link" href="#player/${i.id}">${esc(i.name)}</a>
        <div class="hbar__track"><div class="hbar__fill" style="width:${((i.value / max) * 100).toFixed(1)}%"></div></div>
        <span class="hbar__value num">${fmt(i.value, digits)}<span class="muted small"> ${esc(unit)}</span></span></div>`).join('')}</div>`;
  }
  const chartLabel = (a) => fdate(a.date).slice(0, 5);
  const legend = '<div class="legend"><span><i style="background:var(--kind-match)"></i>משחק</span><span><i style="background:var(--kind-training)"></i>אימון</span><span><i style="background:#8a9a92"></i>ממוצע התקופה (קו מקווקו)</span></div>';

  // ------------------------------------------------------------- UI primitives
  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast is-on' + (isError ? ' toast--error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }
  function openDialog({ title, body, ok = 'שמירה', danger = false, onSubmit }) {
    const dlg = $('#dialog'), form = $('#dialog-form');
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = body;
    $('#dialog-error').textContent = '';
    const okBtn = $('#dialog-ok');
    okBtn.textContent = ok;
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    form.onsubmit = async (e) => {
      if (!e.submitter || e.submitter.value !== 'ok') return;
      e.preventDefault();
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      okBtn.disabled = true;
      try {
        await onSubmit(data, form);
        dlg.close();
      } catch (err) {
        $('#dialog-error').textContent = errMsg(err);
      } finally { okBtn.disabled = false; }
    };
    dlg.showModal();
    const first = $('#dialog-body input, #dialog-body select');
    if (first) first.focus();
  }
  const confirmDialog = (title, text, ok, fn) => openDialog({ title, body: `<p>${text}</p>`, ok, danger: true, onSubmit: fn });

  function fieldInput(label, name, { type = 'text', value = '', required = false, attrs = '' } = {}) {
    return `<label class="field"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${required ? 'required' : ''} ${attrs}></label>`;
  }
  function fieldSelect(label, name, options, value) {
    return `<label class="field"><span>${esc(label)}</span><select name="${name}">${Object.entries(options).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(value) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  }
  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="page-head__actions">${actions}</div></div>`;
  const periodText = () => $('#period-select').selectedOptions[0].textContent;

  // ------------------------------------------------------------- data loading
  async function loadTeamData() {
    if (!state.teamId) { state.raw = null; return; }
    const { prevFrom } = periodBounds();
    state.raw = await api('GET', `/api/teams/${state.teamId}/data${prevFrom ? `?from=${prevFrom}` : ''}`);
  }
  async function refresh() {
    try { await loadTeamData(); } catch (e) { toast(errMsg(e), true); }
    render();
  }
  async function reloadMe() {
    state.me = await api('GET', '/api/me');
    state.teams = state.me.teams;
    if (!state.teams.some((t) => t.id === state.teamId)) {
      const saved = +store.get('team');
      state.teamId = (state.teams.find((t) => t.id === saved) || state.teams[0] || {}).id || null;
    }
  }

  // ------------------------------------------------------------- views
  const views = {};

  views.overview = () => {
    const { players, current, previous } = view();
    const cur = statsOf(rows(current)), prev = statsOf(rows(previous));
    const matches = current.filter((a) => a.kind === 'match').length;
    const pstats = perPlayer(players.filter((p) => p.status === 'active'), current);
    const named = [...pstats.entries()].map(([id, s]) => ({ id, s, p: players.find((x) => x.id === id) }));
    const top = (fn, n = 5) => named.filter((x) => fn(x.s) != null).sort((a, b) => fn(b.s) - fn(a.s)).slice(0, n).map((x) => ({ id: x.id, name: x.p.name, value: fn(x.s) }));
    let topSpeedName = '';
    if (cur.speedMax != null) {
      const r = rows(current).find((x) => x.m.max_speed_kmh === cur.speedMax);
      const p = r && players.find((x) => x.id === r.m.player_id);
      topSpeedName = p ? p.name : '';
    }
    const chrono = [...current].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).slice(-30);
    const points = chrono.map((a) => ({ label: chartLabel(a), title: `${fdate(a.date)} · ${KIND[a.kind]}`, kind: a.kind,
      value: avg(a.metrics.map((m) => m.distance_km).filter((v) => v != null)) }));
    const sprintsSeen = cur.sprintN > 0;

    return pageHead('סקירת קבוצה', `${esc(team().name)} · ${esc(periodText())}`,
      `<a class="btn" href="#activity-new">הזנת פעילות</a><a class="btn btn--primary" href="#import">ייבוא CSV</a>`) +
    (current.length ? '' : `<div class="notice notice--info">אין פעילויות בתקופה שנבחרה. ניתן להזין פעילות ידנית, לייבא קובץ CSV או לבחור תקופה ארוכה יותר.</div><br>`) +
    `<div class="kpis">
      <div class="kpi"><div class="kpi__label">פעילויות</div><div class="kpi__value num">${current.length}</div><div class="kpi__hint">${matches} משחקים · ${current.length - matches} אימונים</div></div>
      <div class="kpi"><div class="kpi__label">מרחק ממוצע לשחקן בפעילות</div><div class="kpi__value"><span class="num">${fmt(cur.distAvg, 2)}</span><span class="kpi__unit">ק״מ</span></div>${delta(cur.distAvg, prev.distAvg)}</div>
      <div class="kpi"><div class="kpi__label">מהירות שיא בקבוצה</div><div class="kpi__value"><span class="num">${fmt(cur.speedMax)}</span><span class="kpi__unit">קמ״ש</span></div><div class="kpi__hint">${esc(topSpeedName)}</div></div>
      <div class="kpi"><div class="kpi__label">עצימות ממוצעת</div><div class="kpi__value"><span class="num">${fmt(cur.intensity, 0)}</span><span class="kpi__unit">מ׳/דקה</span></div>${delta(cur.intensity, prev.intensity)}</div>
      <div class="kpi"><div class="kpi__label">ספרינטים לשחקן בפעילות</div><div class="kpi__value num">${sprintsSeen ? fmt(cur.sprintAvg) : '—'}</div><div class="kpi__hint">${sprintsSeen ? 'רק בפעילויות שבהן הוזן נתון' : 'לא הוזנו נתוני ספרינטים'}</div></div>
    </div>
    <div class="card">
      <div class="card__head"><h2>מרחק ממוצע לשחקן לפי פעילות (ק״מ)</h2>${sourceStrip(current)}</div>
      ${barChart(points, { unit: 'ק״מ' })}${points.length ? legend : ''}
    </div>
    <div class="grid grid--3">
      <div class="card"><div class="card__head"><h2>מרחק ממוצע לפעילות</h2></div>${hbars(top((s) => s.distAvg), 'ק״מ', 2)}</div>
      <div class="card"><div class="card__head"><h2>מהירות שיא</h2></div>${hbars(top((s) => s.speedMax), 'קמ״ש')}</div>
      <div class="card"><div class="card__head"><h2>עצימות (מטר לדקה)</h2></div>${hbars(top((s) => s.intensity), 'מ׳/ד׳', 0)}</div>
    </div>
    <p class="footnote">עצימות = סך המרחק חלקי סך הדקות, רק בשורות שבהן הוזנו שני הערכים. נתון הספרינטים מוצג רק כשהוזן; טרם אומת שהמכשיר מפיק אותו.</p>`;
  };

  views.roster = () => {
    const { players, current } = view();
    const stats = perPlayer(players, current);
    const q = state.rosterQuery.trim().toLowerCase();
    let list = players.filter((p) => (state.rosterArchived || p.status === 'active') &&
      (!state.rosterPos || p.position === state.rosterPos) &&
      (!q || p.name.toLowerCase().includes(q) || String(p.number || '') === q));
    const { key, dir } = state.rosterSort;
    const val = (p) => {
      const s = stats.get(p.id);
      return { number: p.number ?? 999, name: p.name, position: Object.keys(POS).indexOf(p.position), sessions: s.sessions,
        distAvg: s.distAvg ?? -1, speedMax: s.speedMax ?? -1, intensity: s.intensity ?? -1, sprintAvg: s.sprintAvg ?? -1, minutes: s.minutes ?? -1 }[key];
    };
    list = list.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' ? x.localeCompare(y, 'he') : x - y) * dir; });
    const th = (k, label, cls = '') => `<th data-sort="${k}" class="${cls} ${key === k ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${label}</th>`;
    const activeCount = players.filter((p) => p.status === 'active').length;
    return pageHead('סגל שחקנים', `${activeCount} שחקנים פעילים · נתונים עבור ${esc(periodText())}`,
      `<button class="btn btn--primary" data-action="add-player">הוספת שחקן</button>`) +
    `<div class="card">
      <div class="toolbar">
        <input type="search" id="roster-q" placeholder="חיפוש לפי שם או מספר" value="${esc(state.rosterQuery)}">
        <select id="roster-pos"><option value="">כל העמדות</option>${Object.entries(POS).map(([k, v]) => `<option value="${k}" ${state.rosterPos === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" id="roster-archived" ${state.rosterArchived ? 'checked' : ''}> הצגת שחקנים בארכיון</label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>${th('number', '#')}${th('name', 'שם')}${th('position', 'עמדה', 'hide-sm')}${th('sessions', 'פעילויות', 'hide-sm')}${th('distAvg', 'מרחק ממוצע (ק״מ)')}${th('speedMax', 'מהירות שיא')}${th('intensity', 'מ׳/דקה', 'hide-sm')}${th('sprintAvg', 'ספרינטים (ממוצע)', 'hide-sm')}${th('minutes', 'דקות', 'hide-sm')}<th></th></tr></thead>
        <tbody>${list.map((p) => {
          const s = stats.get(p.id);
          return `<tr class="${p.status === 'archived' ? 'is-archived' : ''}">
            <td>${jersey(p.number)}</td>
            <td><a class="player-link" href="#player/${p.id}">${esc(p.name)}</a>${p.status === 'archived' ? ' <span class="badge">ארכיון</span>' : ''}</td>
            <td class="hide-sm">${posTag(p.position)}</td>
            <td class="num hide-sm">${s.sessions}</td>
            <td class="num">${fmt(s.distAvg, 2)}</td>
            <td class="num">${fmt(s.speedMax)}</td>
            <td class="num hide-sm">${fmt(s.intensity, 0)}</td>
            <td class="num hide-sm">${fmt(s.sprintAvg)}</td>
            <td class="num hide-sm">${fmt(s.minutes, 0)}</td>
            <td class="actions"><button class="btn btn--sm" data-action="edit-player" data-id="${p.id}">עריכה</button>
              ${p.status === 'active' ? `<button class="btn btn--sm btn--ghost" data-action="archive-player" data-id="${p.id}">לארכיון</button>` : `<button class="btn btn--sm" data-action="restore-player" data-id="${p.id}">שחזור</button>`}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="10" class="empty">לא נמצאו שחקנים</td></tr>'}</tbody>
      </table></div>
      <p class="footnote">העברה לארכיון שומרת את כל היסטוריית השחקן ומשחררת את מספר החולצה ואת המכשיר המשויך.</p>
    </div>`;
  };

  views.activities = () => {
    const { players, current } = view();
    const pmap = new Map(players.map((p) => [p.id, p]));
    return pageHead('אימונים ומשחקים', `${current.length} פעילויות · ${esc(periodText())}`,
      `<a class="btn btn--primary" href="#activity-new">הזנה ידנית</a><a class="btn" href="#import">ייבוא CSV</a>`) +
    `<div class="card">
      <div class="card__head"><h2>היסטוריית פעילויות</h2>${sourceStrip(current)}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>תאריך</th><th>סוג</th><th class="hide-sm">כותרת</th><th>מקור</th><th class="num">שחקנים</th><th>מרחק ממוצע</th><th class="hide-sm">מהירות שיא</th><th></th></tr></thead>
        <tbody>${current.map((a) => {
          const s = statsOf(a.metrics.map((m) => ({ a, m })));
          const open = state.openActivity === a.id;
          const detail = open ? `<tr class="activity-detail"><td colspan="8"><div class="inner">
              ${a.notes ? `<p class="small">${esc(a.notes)}</p>` : ''}
              <div class="table-wrap"><table><thead><tr><th>שחקן</th><th>מרחק (ק״מ)</th><th>מהירות שיא (קמ״ש)</th><th>ספרינטים</th><th>דקות</th><th class="hide-sm">מ׳/דקה</th></tr></thead><tbody>
              ${[...a.metrics].sort((x, y) => (y.distance_km || 0) - (x.distance_km || 0)).map((m) => { const p = pmap.get(m.player_id) || { name: '?' }; return `<tr>
                <td><a class="player-link" href="#player/${m.player_id}">${esc(p.name)}</a></td><td class="num">${fmt(m.distance_km, 2)}</td><td class="num">${fmt(m.max_speed_kmh)}</td>
                <td class="num">${fmt(m.sprints, 0)}</td><td class="num">${fmt(m.minutes, 0)}</td><td class="num hide-sm">${m.distance_km != null && m.minutes ? fmt(m.distance_km * 1000 / m.minutes, 0) : '—'}</td></tr>`; }).join('')}
              </tbody></table></div></div></td></tr>` : '';
          return `<tr class="activity-row" data-action="toggle-activity" data-id="${a.id}">
            <td class="num">${fdate(a.date)}</td><td>${kindBadge(a.kind)}</td><td class="hide-sm">${esc(a.title)}</td><td>${srcBadge(a.source)}</td>
            <td class="num">${a.metrics.length}</td><td class="num">${fmt(s.distAvg, 2)}</td><td class="num hide-sm">${fmt(s.speedMax)}</td>
            <td class="actions"><button class="btn btn--sm" data-action="edit-activity" data-id="${a.id}">עריכה</button><button class="btn btn--sm btn--danger" data-action="delete-activity" data-id="${a.id}">מחיקה</button></td></tr>${detail}`;
        }).join('') || '<tr><td colspan="8" class="empty">אין פעילויות בתקופה שנבחרה</td></tr>'}</tbody>
      </table></div>
      <p class="footnote">לחיצה על שורה מציגה את נתוני השחקנים בפעילות. פעילות שיובאה מקובץ ניתנת לביטול גם כחלק מהייבוא כולו במסך ״ייבוא וייצוא״.</p>
    </div>`;
  };

  views['activity-new'] = () => {
    const players = view().players.filter((p) => p.status === 'active');
    return pageHead('הזנת פעילות ידנית', 'הנתונים יסומנו כ״הזנה ידנית״. שורה ריקה לא תישמר.') +
    `<form class="card" data-form="activity-new">
      <div class="form-grid">
        ${fieldInput('תאריך', 'date', { type: 'date', value: today(), required: true, attrs: `max="${today()}"` })}
        ${fieldSelect('סוג', 'kind', KIND, 'training')}
        ${fieldInput('כותרת (רשות)', 'title', { attrs: 'maxlength="120" placeholder="לדוגמה: משחק ליגה מול..."' })}
      </div>
      <label class="field" style="margin-top:12px"><span>הערות (רשות)</span><textarea name="notes" maxlength="1000"></textarea></label>
      <div class="table-wrap" style="margin-top:14px"><table class="entry-grid">
        <thead><tr><th>#</th><th>שחקן</th><th>מרחק (ק״מ)</th><th>מהירות שיא (קמ״ש)</th><th>ספרינטים</th><th>דקות</th></tr></thead>
        <tbody>${players.map((p) => `<tr data-player="${p.id}"><td>${jersey(p.number)}</td><td>${esc(p.name)} <span class="muted small">${POS[p.position]}</span></td>
          <td><input inputmode="decimal" name="d_${p.id}" aria-label="מרחק ${esc(p.name)}"></td>
          <td><input inputmode="decimal" name="s_${p.id}" aria-label="מהירות ${esc(p.name)}"></td>
          <td><input inputmode="numeric" name="p_${p.id}" aria-label="ספרינטים ${esc(p.name)}"></td>
          <td><input inputmode="numeric" name="m_${p.id}" aria-label="דקות ${esc(p.name)}"></td></tr>`).join('') || '<tr><td colspan="6" class="empty">אין שחקנים פעילים — הוסף שחקנים בסגל</td></tr>'}</tbody>
      </table></div>
      <p class="form-error" id="activity-error"></p>
      <div class="page-head__actions"><button class="btn btn--primary" type="submit">שמירת פעילות</button><a class="btn btn--ghost" href="#activities">ביטול</a></div>
    </form>`;
  };

  views.player = (id) => {
    const { players, current, previous } = view();
    const p = players.find((x) => x.id === +id);
    if (!p) return pageHead('השחקן לא נמצא', '') + '<a class="btn" href="#roster">חזרה לסגל</a>';
    const mine = rows(current, p.id), prevMine = rows(previous, p.id);
    const s = statsOf(mine), ps = statsOf(prevMine);
    const peers = players.filter((x) => x.position === p.position && x.status === 'active');
    const peerStats = [...perPlayer(peers, current).values()].filter((x) => x.sessions);
    const peerAvg = (k) => avg(peerStats.map((x) => x[k]).filter((v) => v != null));
    const chrono = [...mine].sort((a, b) => a.a.date.localeCompare(b.a.date));
    const pts = (k) => chrono.map((r) => ({ label: chartLabel(r.a), title: `${fdate(r.a.date)} · ${KIND[r.a.kind]}`, value: r.m[k], kind: r.a.kind }));
    const cmp = (label, k, unit, d) => `<tr><td>${label}</td><td class="num"><strong>${fmt(s[k], d)}</strong> ${unit}</td><td class="num">${fmt(peerAvg(k), d)} ${unit}</td></tr>`;
    return pageHead(`${esc(p.name)} ${p.number != null ? `<span class="muted num">#${esc(p.number)}</span>` : ''}`,
      `${POS[p.position]} · ${esc(periodText())}${p.status === 'archived' ? ' · בארכיון' : ''}`,
      `<button class="btn" data-action="compare-with" data-id="${p.id}">השוואה לשחקנים אחרים</button><button class="btn" data-action="print">הדפסה / PDF</button>`) +
    `<div class="kpis">
      <div class="kpi"><div class="kpi__label">פעילויות</div><div class="kpi__value num">${s.sessions}</div><div class="kpi__hint">${fmt(s.minutes, 0)} דקות</div></div>
      <div class="kpi"><div class="kpi__label">מרחק ממוצע לפעילות</div><div class="kpi__value"><span class="num">${fmt(s.distAvg, 2)}</span><span class="kpi__unit">ק״מ</span></div>${delta(s.distAvg, ps.distAvg)}</div>
      <div class="kpi"><div class="kpi__label">מרחק מצטבר</div><div class="kpi__value"><span class="num">${fmt(s.distTotal, 1)}</span><span class="kpi__unit">ק״מ</span></div></div>
      <div class="kpi"><div class="kpi__label">מהירות שיא</div><div class="kpi__value"><span class="num">${fmt(s.speedMax)}</span><span class="kpi__unit">קמ״ש</span></div>${delta(s.speedMax, ps.speedMax)}</div>
      <div class="kpi"><div class="kpi__label">עצימות</div><div class="kpi__value"><span class="num">${fmt(s.intensity, 0)}</span><span class="kpi__unit">מ׳/דקה</span></div>${delta(s.intensity, ps.intensity)}</div>
    </div>
    <div class="grid grid--2">
      <div class="card"><div class="card__head"><h2>מרחק לפי פעילות (ק״מ)</h2></div>${barChart(pts('distance_km'), { unit: 'ק״מ', height: 240, width: 480 })}${mine.length ? legend : ''}</div>
      <div class="card"><div class="card__head"><h2>מהירות שיא לפי פעילות (קמ״ש)</h2></div>${lineChart(pts('max_speed_kmh'), { unit: 'קמ״ש', height: 240, width: 480 })}</div>
    </div>
    <div class="grid grid--2">
      <div class="card"><div class="card__head"><h2>השוואה לממוצע העמדה (${POS[p.position]})</h2></div>
        <table><thead><tr><th>מדד</th><th>${esc(p.name)}</th><th>ממוצע ${peerStats.length} שחקני ${POS[p.position]}</th></tr></thead><tbody>
          ${cmp('מרחק ממוצע לפעילות', 'distAvg', 'ק״מ', 2)}${cmp('מהירות שיא', 'speedMax', 'קמ״ש', 1)}${cmp('עצימות', 'intensity', 'מ׳/ד׳', 0)}${cmp('ספרינטים לפעילות', 'sprintAvg', '', 1)}
        </tbody></table></div>
      <div class="card"><div class="card__head"><h2>מקור הנתונים</h2></div>
        ${sourceStrip(mine.map((r) => r.a)) || '<p class="muted">אין נתונים בתקופה</p>'}
        <p class="footnote">כל שורה בטבלה למטה מסומנת במקור שלה. נתוני GPS מהמכשיר (מסלולים ומפות חום) אינם זמינים עד שיאומת ממשק לייצוא הנתונים מהאפליקציה של הספק.</p></div>
    </div>
    <div class="card"><div class="card__head"><h2>היסטוריית פעילויות</h2></div>
      <div class="table-wrap"><table><thead><tr><th>תאריך</th><th>סוג</th><th class="hide-sm">כותרת</th><th>מקור</th><th>מרחק</th><th>מהירות</th><th class="hide-sm">ספרינטים</th><th class="hide-sm">דקות</th><th class="hide-sm">מ׳/דקה</th></tr></thead><tbody>
      ${[...mine].sort((a, b) => b.a.date.localeCompare(a.a.date)).map(({ a, m }) => `<tr><td class="num">${fdate(a.date)}</td><td>${kindBadge(a.kind)}</td><td class="hide-sm">${esc(a.title)}</td><td>${srcBadge(a.source)}</td>
        <td class="num">${fmt(m.distance_km, 2)}</td><td class="num">${fmt(m.max_speed_kmh)}</td><td class="num hide-sm">${fmt(m.sprints, 0)}</td><td class="num hide-sm">${fmt(m.minutes, 0)}</td>
        <td class="num hide-sm">${m.distance_km != null && m.minutes ? fmt(m.distance_km * 1000 / m.minutes, 0) : '—'}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">אין פעילויות בתקופה שנבחרה</td></tr>'}
      </tbody></table></div></div>`;
  };

  views.compare = () => {
    const { players, current } = view();
    const active = players.filter((p) => p.status === 'active');
    state.compare = state.compare.filter((id) => active.some((p) => p.id === id));
    const sel = state.compare.map((id) => active.find((p) => p.id === id));
    const stats = perPlayer(active, current);
    const teamStats = statsOf(rows(current));
    const metrics = [
      ['פעילויות', 'sessions', 0, ''], ['מרחק ממוצע לפעילות', 'distAvg', 2, 'ק״מ'], ['מרחק מצטבר', 'distTotal', 1, 'ק״מ'],
      ['מהירות שיא', 'speedMax', 1, 'קמ״ש'], ['עצימות', 'intensity', 0, 'מ׳/ד׳'], ['ספרינטים לפעילות', 'sprintAvg', 1, ''], ['דקות', 'minutes', 0, ''],
    ];
    const table = sel.length < 2 ? '<p class="empty">בחר לפחות שני שחקנים להשוואה (עד ארבעה)</p>' :
      `<div class="table-wrap"><table><thead><tr><th>מדד</th>${sel.map((p) => `<th><a class="player-link" href="#player/${p.id}">${esc(p.name)}</a><div class="muted small">${POS[p.position]}</div></th>`).join('')}<th class="muted">ממוצע קבוצה</th></tr></thead><tbody>
      ${metrics.map(([label, k, d, unit]) => {
        const vals = sel.map((p) => stats.get(p.id)[k]);
        const best = Math.max(...vals.filter((v) => v != null));
        const teamVal = k === 'sessions' ? null : k === 'distTotal' || k === 'minutes' ? null : teamStats[k === 'speedMax' ? 'speedAvg' : k];
        return `<tr><td>${label} ${unit ? `<span class="muted small">(${unit})</span>` : ''}</td>${vals.map((v) => `<td class="num ${v != null && v === best && sel.length > 1 ? 'best' : ''}">${fmt(v, d)}</td>`).join('')}<td class="num muted">${fmt(teamVal, d)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="footnote">הערך הגבוה בכל שורה מודגש. ״ממוצע קבוצה״ במהירות שיא הוא ממוצע מהירויות השיא בכל הפעילויות, לא השיא הקבוצתי.</p>`;
    const bars = sel.length < 2 ? '' : `<div class="grid grid--2">
      <div class="card"><div class="card__head"><h2>מרחק ממוצע לפעילות</h2></div>${hbars(sel.filter((p) => stats.get(p.id).distAvg != null).map((p) => ({ id: p.id, name: p.name, value: stats.get(p.id).distAvg })), 'ק״מ', 2)}</div>
      <div class="card"><div class="card__head"><h2>מהירות שיא</h2></div>${hbars(sel.filter((p) => stats.get(p.id).speedMax != null).map((p) => ({ id: p.id, name: p.name, value: stats.get(p.id).speedMax })), 'קמ״ש')}</div></div>`;
    return pageHead('השוואת שחקנים', esc(periodText())) +
    `<div class="card"><div class="card__head"><h2>בחירת שחקנים</h2><span class="muted small">${sel.length}/4 נבחרו</span></div>
      <div class="compare-picker">${active.map((p) => `<button class="chip ${state.compare.includes(p.id) ? 'is-on' : ''}" data-action="toggle-compare" data-id="${p.id}">${p.number != null ? `<span class="num">${esc(p.number)}</span> · ` : ''}${esc(p.name)}</button>`).join('')}</div></div>
    <div class="card">${table}</div>${bars}`;
  };

  views.import = async () => {
    let imports = [];
    try { imports = (await api('GET', `/api/teams/${state.teamId}/imports`)).imports; } catch (e) { toast(errMsg(e), true); }
    const plan = state.importPlan;
    const pl = plan && plan.committed ? null : state.importPayload;
    const preview = !plan ? '' : `<div class="card" id="import-preview">
      <div class="card__head"><h2>${plan.committed ? 'הייבוא הושלם' : 'תוצאות בדיקת הקובץ'}</h2><span class="muted small">${plan.row_count} שורות</span></div>
      ${plan.errors.length ? `<div class="notice notice--error"><strong>נמצאו ${plan.errors.length} שגיאות. הקובץ לא יובא — יש לתקן ולנסות שוב.</strong><ul>${plan.errors.slice(0, 30).map((e) => `<li>שורה <span class="num">${e.line}</span>: ${esc(e.message)}</li>`).join('')}</ul>${plan.errors.length > 30 ? `<p>ועוד ${plan.errors.length - 30} שגיאות</p>` : ''}</div>` : ''}
      ${plan.warnings.length ? `<div class="notice notice--warn"><ul>${[...new Set(plan.warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${plan.committed ? `<div class="notice notice--ok">נוספו ${plan.activities.length} פעילויות${plan.new_players.length ? ` ו-${plan.new_players.length} שחקנים חדשים` : ''}. הנתונים מסומנים כ״ייבוא CSV״.</div>` : ''}
      ${!plan.errors.length && !plan.committed ? `<div class="notice notice--info">הקובץ תקין. ייווצרו ${plan.activities.length} פעילויות${plan.new_players.length ? ` ו-${plan.new_players.length} שחקנים חדשים: ${plan.new_players.map((p) => esc(p.name)).join(', ')}` : ''}.</div>` : ''}
      ${plan.activities.length ? `<div class="table-wrap"><table><thead><tr><th>תאריך</th><th>סוג</th><th>כותרת</th><th class="num">שחקנים</th></tr></thead><tbody>${plan.activities.map((a) => `<tr><td class="num">${fdate(a.date)}</td><td>${kindBadge(a.kind)}</td><td>${esc(a.title)}</td><td class="num">${a.players}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${!plan.errors.length && !plan.committed ? `<div class="page-head__actions" style="margin-top:12px"><button class="btn btn--primary" data-action="commit-import">אישור וייבוא</button><button class="btn btn--ghost" data-action="cancel-import">ביטול</button></div>` : ''}
    </div>`;
    return pageHead('ייבוא וייצוא נתונים', 'CSV הוא דרך ההזנה הזמנית עד לחיבור מאומת למכשיר.') +
    `<div class="grid grid--2">
      <form class="card" data-form="import-check">
        <div class="card__head"><h2>ייבוא קובץ CSV</h2></div>
        <label class="field"><span>קובץ</span><input type="file" name="file" accept=".csv,text/csv" ${pl ? '' : 'required'}></label>
        ${pl && !(plan && plan.committed) ? `<p class="small muted">קובץ טעון: <strong>${esc(pl.filename)}</strong> — ניתן לשנות אפשרויות ולבדוק שוב בלי לבחור אותו מחדש.</p>` : ''}
        <div class="form-grid" style="margin-top:12px">
          ${fieldInput('תאריך (אם אין עמודת date)', 'default_date', { type: 'date', value: (pl && pl.default_date) || today(), attrs: `max="${today()}"` })}
          ${fieldSelect('סוג (אם אין עמודת type)', 'default_kind', KIND, (pl && pl.default_kind) || 'training')}
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="create_missing_players" ${pl && pl.create_missing_players ? 'checked' : ''}> יצירת שחקנים שאינם בסגל (נדרשת עמודת position)</label>
        <p class="footnote">הקובץ נבדק לפני הייבוא. אם יש שגיאה אחת לפחות — שום נתון לא נשמר. ייבוא מוסיף פעילויות להיסטוריה ואינו מוחק נתונים קיימים.</p>
        <div class="page-head__actions"><button class="btn btn--primary" type="submit">בדיקת הקובץ</button></div>
      </form>
      <div class="card">
        <div class="card__head"><h2>מבנה הקובץ</h2><button class="btn btn--sm" data-action="download-template">הורדת קובץ לדוגמה</button></div>
        <dl class="facts">
          <dt>חובה</dt><dd><code>name, distance, speed, minutes</code></dd>
          <dt>מומלץ</dt><dd><code>date, type, title, number, position, sprints</code></dd>
          <dt>יחידות</dt><dd>מרחק בק״מ, מהירות בקמ״ש, זמן בדקות</dd>
          <dt>תאריך</dt><dd><code>YYYY-MM-DD</code> או <code>DD/MM/YYYY</code></dd>
          <dt>סוג</dt><dd><code>training/match</code> או אימון/משחק</dd>
          <dt>עמדה</dt><dd><code>GK/DEF/MID/FWD</code> או שוער/הגנה/קישור/התקפה</dd>
          <dt>התאמת שחקן</dt><dd>לפי מספר חולצה, ואם אין — לפי שם מלא</dd>
        </dl>
        <p class="footnote">גם הפורמט הקודם (<code>name,position,number,distance,speed,sprints,minutes</code>) נתמך: התאריך והסוג נלקחים מהטופס. שורות עם אותם תאריך, סוג וכותרת מקובצות לפעילות אחת.</p>
      </div>
    </div>
    ${preview}
    <div class="grid grid--2">
      <div class="card"><div class="card__head"><h2>ייצוא</h2></div>
        <p>ייצוא כל היסטוריית הפעילויות של הקבוצה, כולל עמודת מקור לכל שורה. הקובץ נפתח ב-Excel בעברית.</p>
        <button class="btn" data-action="export-csv">ייצוא CSV</button></div>
      <div class="card"><div class="card__head"><h2>היסטוריית ייבוא</h2></div>
        ${imports.length ? `<div class="table-wrap"><table><thead><tr><th>מועד</th><th>קובץ</th><th class="num">שורות</th><th class="num">פעילויות</th><th></th></tr></thead><tbody>
        ${imports.map((i) => `<tr><td class="num small">${fdatetime(i.created_at)}</td><td>${esc(i.filename || '—')}</td><td class="num">${i.row_count}</td><td class="num">${i.activities}</td>
          <td class="actions"><button class="btn btn--sm btn--danger" data-action="undo-import" data-id="${i.id}">ביטול ייבוא</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">טרם בוצע ייבוא לקבוצה זו</p>'}
      </div>
    </div>`;
  };

  views.devices = () => {
    const { players } = view();
    const devices = state.raw.devices;
    const active = players.filter((p) => p.status === 'active');
    return pageHead('מכשירים', 'רישום מכשירי ANOX ושיוכם לשחקנים', '<button class="btn btn--primary" data-action="add-device">הוספת מכשיר</button>') +
    `<div class="grid grid--2">
      <div class="card"><div class="card__head"><h2>סטטוס חיבור למכשיר</h2><span class="badge badge--warn">טרם חובר</span></div>
        <dl class="facts">
          <dt>דגם</dt><dd>Action Tracer AT01 / AT‑01 (לפי מדריך הספק)</dd>
          <dt>יצרן</dt><dd>Sibo Technology (Zhuhai) Co., Ltd.</dd>
          <dt>אפליקציה</dt><dd>Action Tracer (iOS: App Store; Android: קובץ APK מאתר ql-sport.com)</dd>
          <dt>ייצוא</dt><dd>קובץ XLSX לפי הספק. מבנה העמודות טרם נבדק על קובץ אמיתי</dd>
          <dt>API / SDK</dt><dd>לא צוין בתשובת הספק</dd>
          <dt>ריבוי שחקנים</dt><dd>לפי הספק, מאמן מסנכרן כמה שחקנים מאותה אפליקציה</dd>
          <dt>הקלטה</dt><dd>עד 2.5 שעות ועד 15 מקטעים לפי המדריך; נתונים חדשים עשויים לדרוס ישנים</dd>
          <dt>מעקב חי</dt><dd>לא נתמך במערכת ולא אומת במכשיר</dd>
        </dl>
        <p class="footnote">השלב הבא: ייבוא ישיר של קובץ ה-XLSX מהאפליקציה, לאחר בדיקת קובץ ייצוא אמיתי. עד אז, נתונים נכנסים בהזנה ידנית או ב-CSV. סנכרן את המכשיר באפליקציה בסמוך לסיום כל פעילות כדי שהקלטות לא יידרסו.</p></div>
      <div class="card"><div class="card__head"><h2>למה לרשום מכשירים כבר עכשיו</h2></div>
        <p>כל מכשיר משויך לשחקן אחד בכל רגע, וההיסטוריה של השיוכים נשמרת. כשיתווסף חיבור לנתוני המכשיר, המערכת תשייך כל הקלטה לשחקן שהחזיק במכשיר באותו מועד, והנתונים יסומנו כ״מכשיר״.</p>
        <p class="muted small">העברת מכשיר לשחקן אחר משחררת אותו אוטומטית מהשחקן הקודם.</p></div>
    </div>
    <div class="card"><div class="card__head"><h2>מכשירים רשומים</h2><span class="muted small">${devices.length}</span></div>
      <div class="table-wrap"><table><thead><tr><th>תווית</th><th class="hide-sm">מספר סידורי</th><th>דגם</th><th>משויך לשחקן</th><th class="hide-sm">מאז</th></tr></thead><tbody>
      ${devices.map((d) => `<tr><td><strong>${esc(d.label)}</strong></td><td class="hide-sm num">${esc(d.serial || '—')}</td><td>${esc(d.model)}</td>
        <td><select data-assign="${d.id}" aria-label="שיוך ${esc(d.label)}"><option value="">— לא משויך —</option>${active.map((p) => `<option value="${p.id}" ${d.player_id === p.id ? 'selected' : ''}>${p.number != null ? esc(p.number) + ' · ' : ''}${esc(p.name)}</option>`).join('')}</select></td>
        <td class="hide-sm small">${d.player_id ? fdatetime(d.assigned_at) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">לא נרשמו מכשירים</td></tr>'}
      </tbody></table></div></div>`;
  };

  views.admin = async () => {
    if (!isOwner()) return pageHead('אין הרשאה', 'מסך זה זמין למנהל הפלטפורמה בלבד');
    const [{ teams }, { users }, { entries }] = await Promise.all([
      api('GET', '/api/admin/teams'), api('GET', '/api/admin/users'), api('GET', '/api/admin/audit?limit=40')]);
    const tname = new Map(teams.map((t) => [t.id, t.name]));
    const paying = teams.filter((t) => t.plan === 'paid' && t.status === 'active' && !t.is_demo).length;
    return pageHead('ניהול הפלטפורמה', 'קבוצות, מנהלים ויומן פעולות',
      '<button class="btn" data-action="add-manager">מנהל קבוצה חדש</button><button class="btn btn--primary" data-action="add-team">קבוצה חדשה</button>') +
    `<div class="kpis">
      <div class="kpi"><div class="kpi__label">קבוצות</div><div class="kpi__value num">${teams.filter((t) => !t.is_demo).length}</div><div class="kpi__hint">ללא קבוצות הדגמה</div></div>
      <div class="kpi"><div class="kpi__label">פעילות</div><div class="kpi__value num">${teams.filter((t) => t.status === 'active' && !t.is_demo).length}</div></div>
      <div class="kpi"><div class="kpi__label">במנוי בתשלום</div><div class="kpi__value num">${paying}</div><div class="kpi__hint">סימון ידני — אין עדיין סליקה</div></div>
      <div class="kpi"><div class="kpi__label">מנהלי קבוצות פעילים</div><div class="kpi__value num">${users.filter((u) => u.role === 'manager' && u.active).length}</div></div>
    </div>
    <div class="card"><div class="card__head"><h2>קבוצות</h2></div>
      <div class="table-wrap"><table><thead><tr><th>קבוצה</th><th>מסלול</th><th>סטטוס</th><th class="num">שחקנים</th><th class="num hide-sm">פעילויות</th><th class="hide-sm">פעילות אחרונה</th><th class="num hide-sm">מנהלים</th><th></th></tr></thead><tbody>
      ${teams.map((t) => `<tr><td><strong>${esc(t.name)}</strong>${t.is_demo ? ' <span class="badge badge--demo">הדגמה</span>' : ''}</td><td>${esc(PLAN[t.plan])}</td>
        <td><span class="badge ${t.status === 'active' ? 'badge--ok' : 'badge--off'}">${TEAM_STATUS[t.status]}</span></td>
        <td class="num">${t.players}</td><td class="num hide-sm">${t.activities}</td><td class="num hide-sm">${fdate(t.last_activity)}</td><td class="num hide-sm">${t.managers}</td>
        <td class="actions"><button class="btn btn--sm" data-action="open-team" data-id="${t.id}">כניסה</button><button class="btn btn--sm" data-action="edit-team" data-id="${t.id}">עריכה</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">טרם נוצרו קבוצות</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><div class="card__head"><h2>משתמשים</h2></div>
      <div class="table-wrap"><table><thead><tr><th>שם</th><th>אימייל</th><th>תפקיד / קבוצה</th><th>סטטוס</th><th class="hide-sm">כניסה אחרונה</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td class="num small">${esc(u.email)}</td>
        <td>${u.role === 'owner' ? 'מנהל פלטפורמה' : esc(tname.get(u.team_id) || '—')}</td>
        <td>${u.active ? '<span class="badge badge--ok">פעיל</span>' : '<span class="badge badge--off">מושבת</span>'}${u.must_change_password ? ' <span class="badge badge--warn">סיסמה זמנית</span>' : ''}</td>
        <td class="hide-sm small">${fdatetime(u.last_login_at)}</td>
        <td class="actions">${u.role === 'owner' ? '' : `<button class="btn btn--sm" data-action="reset-password" data-id="${u.id}">איפוס סיסמה</button>
          <button class="btn btn--sm ${u.active ? 'btn--danger' : ''}" data-action="toggle-user" data-id="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'השבתה' : 'הפעלה'}</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card"><div class="card__head"><h2>יומן פעולות אחרונות</h2></div>
      <div class="table-wrap"><table><thead><tr><th>מועד</th><th>פעולה</th><th>קבוצה</th><th class="hide-sm">משתמש</th></tr></thead><tbody>
      ${entries.map((e) => `<tr><td class="num small">${fdatetime(e.at)}</td><td>${esc(AUDIT[e.action] || e.action)}</td><td>${esc(e.team_name || '—')}</td><td class="hide-sm small">${esc(e.user_email || 'מערכת')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">אין רשומות</td></tr>'}
      </tbody></table></div></div>`;
  };

  views.account = () => {
    const u = state.me.user;
    return pageHead('החשבון שלי', esc(u.email)) +
    (u.must_change_password ? '<div class="notice notice--warn">הסיסמה הנוכחית היא זמנית. יש לבחור סיסמה חדשה לפני המשך העבודה.</div><br>' : '') +
    `<form class="card" data-form="password" style="max-width:480px">
      <div class="card__head"><h2>שינוי סיסמה</h2></div>
      ${fieldInput('סיסמה נוכחית', 'current', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })}<br>
      ${fieldInput('סיסמה חדשה (10 תווים לפחות)', 'new', { type: 'password', required: true, attrs: 'minlength="10" autocomplete="new-password"' })}<br>
      ${fieldInput('אימות סיסמה חדשה', 'confirm', { type: 'password', required: true, attrs: 'minlength="10" autocomplete="new-password"' })}
      <p class="form-error" id="password-error"></p>
      <button class="btn btn--primary" type="submit">עדכון סיסמה</button>
      <p class="footnote">לאחר השינוי, חיבורים פעילים במכשירים אחרים יתנתקו.</p>
    </form>`;
  };

  // ------------------------------------------------------------- render
  function parseRoute() {
    const h = location.hash.replace(/^#/, '') || 'overview';
    const [name, arg] = h.split('/');
    return { name: views[name] ? name : 'overview', arg };
  }

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const r = parseRoute();
    const el = $('#view');
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('is-active', a.dataset.route === r.name || (r.name === 'player' && a.dataset.route === 'roster') || (r.name === 'activity-new' && a.dataset.route === 'activities')));
    renderChrome();
    if (state.me && state.me.user.must_change_password && r.name !== 'account') { location.hash = '#account'; return; }
    if (!state.teamId && r.name !== 'admin' && r.name !== 'account') {
      el.innerHTML = pageHead('אין קבוצות', isOwner() ? 'צור קבוצה ראשונה במסך ניהול הפלטפורמה.' : 'החשבון אינו משויך לקבוצה.') +
        (isOwner() ? '<a class="btn btn--primary" href="#admin">ניהול הפלטפורמה</a>' : '');
      return;
    }
    if (state.teamId && !state.raw && r.name !== 'admin' && r.name !== 'account') {
      el.innerHTML = `<div class="notice notice--error">לא ניתן לטעון את נתוני הקבוצה. <button class="btn btn--sm" data-action="retry">ניסיון חוזר</button></div>`;
      return;
    }
    try {
      const html = await views[r.name](r.arg);
      if (seq !== renderSeq) return;
      el.innerHTML = html;
    } catch (e) {
      if (seq !== renderSeq) return;
      if (e.status === 401) return showLogin();
      el.innerHTML = `<div class="notice notice--error">${esc(errMsg(e))}</div>`;
    }
  }

  function renderChrome() {
    const demo = state.backend.mode === 'demo';
    const t = team();
    const sel = $('#team-select');
    sel.innerHTML = state.teams.map((x) => `<option value="${x.id}" ${x.id === state.teamId ? 'selected' : ''}>${esc(x.name)}${x.status === 'suspended' ? ' (מושהית)' : ''}</option>`).join('');
    const single = state.teams.length <= 1;
    sel.hidden = single;
    $('#team-name').hidden = !single;
    $('#team-name').textContent = t ? t.name : '';
    document.querySelectorAll('[data-owner-only]').forEach((a) => { a.hidden = !isOwner(); });
    document.querySelectorAll('[data-account-only]').forEach((a) => { a.hidden = demo; });
    const u = state.me.user;
    $('#topbar-user').innerHTML = demo
      ? `<span class="badge badge--demo hide-sm">מצב הדגמה</span><button class="btn btn--sm btn--primary" data-action="go-login">כניסה לחשבון</button>`
      : `<span class="who muted">${esc(u.name)}</span><button class="btn btn--sm" data-action="logout">יציאה</button>`;
    $('#sidebar-foot').innerHTML = demo
      ? '<strong>מצב הדגמה</strong>הנתונים מומצאים ונמחקים ברענון'
      : `<strong>${esc(u.name)}</strong>${u.role === 'owner' ? 'מנהל פלטפורמה' : 'מנהל קבוצה'}${t ? ` · ${esc(PLAN[t.plan])}` : ''}`;
    const banner = $('#mode-banner');
    if (demo) {
      banner.hidden = false;
      banner.innerHTML = location.protocol === 'file:'
        ? 'מצב הדגמה: כל הנתונים מומצאים לצורך הצגה ונמחקים ברענון הדף. לעבודה עם חשבונות ושמירה קבועה יש להפעיל את השרת: <code>python3 server.py</code>'
        : 'מצב הדגמה: כל הנתונים מומצאים לצורך הצגה ונמחקים ברענון הדף.';
    } else if (t && t.is_demo) {
      banner.hidden = false;
      banner.textContent = 'קבוצת הדגמה: הנתונים בקבוצה זו נוצרו אוטומטית ואינם נתוני שחקנים אמיתיים.';
    } else if (t && t.status === 'suspended') {
      banner.hidden = false;
      banner.textContent = 'הקבוצה מושהית: מנהלי הקבוצה אינם יכולים להתחבר אליה. רק מנהל הפלטפורמה רואה אותה.';
    } else banner.hidden = true;
  }

  // ------------------------------------------------------------- actions
  const playerForm = (p = {}) => `
    ${fieldInput('שם מלא', 'name', { value: p.name || '', required: true, attrs: 'maxlength="80"' })}
    <div class="form-grid">${fieldSelect('עמדה', 'position', POS, p.position || 'MID')}
    ${fieldInput('מספר חולצה', 'number', { type: 'number', value: p.number ?? '', attrs: 'min="1" max="99"' })}</div>`;
  const findPlayer = (id) => state.raw.players.find((p) => p.id === +id);
  const findActivity = (id) => state.raw.activities.find((a) => a.id === +id);

  const actions = {
    'toggle-nav': () => $('#app').classList.toggle('nav-open'),
    'close-nav': () => $('#app').classList.remove('nav-open'),
    retry: () => refresh(),
    print: () => window.print(),
    'enter-demo': () => startDemo(),
    'go-login': () => showLogin(),
    logout: async () => { try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ } location.hash = ''; showLogin(); },
    'add-player': () => openDialog({ title: 'הוספת שחקן', body: playerForm(), onSubmit: async (d) => {
      await api('POST', `/api/teams/${state.teamId}/players`, { name: d.name, position: d.position, number: d.number || null });
      toast('השחקן נוסף'); await refresh();
    } }),
    'edit-player': (el) => { const p = findPlayer(el.dataset.id); openDialog({ title: `עריכת ${p.name}`, body: playerForm(p), onSubmit: async (d) => {
      await api('PATCH', `/api/teams/${state.teamId}/players/${p.id}`, { name: d.name, position: d.position, number: d.number || null });
      toast('הפרטים עודכנו'); await refresh();
    } }); },
    'archive-player': (el) => { const p = findPlayer(el.dataset.id); confirmDialog('העברה לארכיון', `${esc(p.name)} יוסר מהסגל הפעיל. ההיסטוריה שלו תישמר וניתן לשחזר אותו.`, 'העברה לארכיון', async () => {
      await api('PATCH', `/api/teams/${state.teamId}/players/${p.id}`, { status: 'archived' }); toast('השחקן הועבר לארכיון'); await refresh();
    }); },
    'restore-player': async (el) => {
      try { await api('PATCH', `/api/teams/${state.teamId}/players/${el.dataset.id}`, { status: 'active' }); toast('השחקן שוחזר'); await refresh(); } catch (e) { toast(errMsg(e), true); }
    },
    'toggle-activity': (el, ev) => {
      if (ev.target.closest('button, a')) return;
      state.openActivity = state.openActivity === +el.dataset.id ? null : +el.dataset.id; render();
    },
    'edit-activity': (el) => { const a = findActivity(el.dataset.id); openDialog({ title: 'עריכת פרטי פעילות', body: `
      <div class="form-grid">${fieldInput('תאריך', 'date', { type: 'date', value: a.date, required: true, attrs: `max="${today()}"` })}${fieldSelect('סוג', 'kind', KIND, a.kind)}</div>
      ${fieldInput('כותרת', 'title', { value: a.title, attrs: 'maxlength="120"' })}
      <label class="field"><span>הערות</span><textarea name="notes" maxlength="1000">${esc(a.notes || '')}</textarea></label>
      <p class="footnote">מקור הנתונים (${esc(SOURCE[a.source])}) אינו ניתן לשינוי. לתיקון ערכי ביצוע יש למחוק ולהזין מחדש.</p>`,
      onSubmit: async (d) => { await api('PATCH', `/api/teams/${state.teamId}/activities/${a.id}`, d); toast('הפעילות עודכנה'); await refresh(); } }); },
    'delete-activity': (el) => { const a = findActivity(el.dataset.id); confirmDialog('מחיקת פעילות', `למחוק את ה${KIND[a.kind]} מתאריך ${fdate(a.date)} (${a.metrics.length} שחקנים)? הפעולה אינה הפיכה.`, 'מחיקה', async () => {
      await api('DELETE', `/api/teams/${state.teamId}/activities/${a.id}`); toast('הפעילות נמחקה'); await refresh();
    }); },
    'toggle-compare': (el) => {
      const id = +el.dataset.id;
      if (state.compare.includes(id)) state.compare = state.compare.filter((x) => x !== id);
      else if (state.compare.length < 4) state.compare.push(id);
      else return toast('ניתן להשוות עד ארבעה שחקנים', true);
      render();
    },
    'compare-with': (el) => { const id = +el.dataset.id; if (!state.compare.includes(id)) state.compare = [id, ...state.compare].slice(0, 4); location.hash = '#compare'; },
    'commit-import': async (el) => {
      el.disabled = true;
      try {
        state.importPlan = await api('POST', `/api/teams/${state.teamId}/import/csv`, { ...state.importPayload, dry_run: false });
        if (state.importPlan.committed) { toast('הייבוא הושלם'); await loadTeamData(); }
      } catch (e) { toast(errMsg(e), true); }
      render();
    },
    'cancel-import': () => { state.importPlan = null; state.importPayload = null; render(); },
    'undo-import': (el) => confirmDialog('ביטול ייבוא', 'כל הפעילויות שנוספו בייבוא זה יימחקו. שחקנים שנוצרו בייבוא יישארו בסגל.', 'ביטול הייבוא', async () => {
      await api('DELETE', `/api/teams/${state.teamId}/imports/${el.dataset.id}`); state.importPlan = null; toast('הייבוא בוטל'); await refresh();
    }),
    'download-template': () => {
      const d = today(), y = addDays(d, -1);
      download('anox-template.csv', '﻿date,type,title,name,position,number,distance,speed,sprints,minutes\n' +
        `${y},match,משחק ליגה,ישראל ישראלי,MID,8,10.4,30.2,17,90\n${y},match,משחק ליגה,דוד כהן,FWD,9,9.1,31.6,21,78\n${d},training,אימון,ישראל ישראלי,MID,8,6.2,27.4,9,75\n`);
    },
    'export-csv': async () => {
      if (state.backend.mode === 'demo') return download(`anox-demo-team-${state.teamId}.csv`, state.backend.exportCsv(state.teamId));
      location.href = `/api/teams/${state.teamId}/export.csv`;
    },
    'add-device': () => openDialog({ title: 'הוספת מכשיר', body: `
      ${fieldInput('תווית (מודבקת על המכשיר)', 'label', { required: true, attrs: 'maxlength="40" placeholder="AT01-05"' })}
      ${fieldInput('מספר סידורי (רשות)', 'serial', { attrs: 'maxlength="80"' })}`,
      onSubmit: async (d) => { await api('POST', `/api/teams/${state.teamId}/devices`, d); toast('המכשיר נוסף'); await refresh(); } }),
    'open-team': async (el) => { await selectTeam(+el.dataset.id); location.hash = '#overview'; },
    'add-team': () => openDialog({ title: 'קבוצה חדשה', body: `${fieldInput('שם הקבוצה', 'name', { required: true, attrs: 'maxlength="80"' })}${fieldSelect('מסלול', 'plan', PLAN, 'pilot')}`,
      onSubmit: async (d) => { const r = await api('POST', '/api/admin/teams', d); await reloadMe(); toast(`הקבוצה ${r.team.name} נוצרה`); render(); } }),
    'edit-team': async (el) => {
      const { teams } = await api('GET', '/api/admin/teams');
      const t = teams.find((x) => x.id === +el.dataset.id);
      openDialog({ title: `עריכת ${t.name}`, body: `${fieldInput('שם הקבוצה', 'name', { value: t.name, required: true, attrs: 'maxlength="80"' })}
        <div class="form-grid">${fieldSelect('מסלול', 'plan', PLAN, t.plan)}${fieldSelect('סטטוס', 'status', TEAM_STATUS, t.status)}</div>
        <p class="footnote">השהיית קבוצה מנתקת את מנהליה ומונעת מהם גישה. הנתונים נשמרים.</p>`,
        onSubmit: async (d) => { await api('PATCH', `/api/admin/teams/${t.id}`, d); await reloadMe(); toast('הקבוצה עודכנה'); render(); } });
    },
    'add-manager': async () => {
      const { teams } = await api('GET', '/api/admin/teams');
      if (!teams.length) return toast('יש ליצור קבוצה תחילה', true);
      openDialog({ title: 'מנהל קבוצה חדש', body: `
        ${fieldInput('שם', 'name', { required: true, attrs: 'maxlength="80"' })}
        ${fieldInput('אימייל', 'email', { type: 'email', required: true })}
        ${fieldSelect('קבוצה', 'team_id', Object.fromEntries(teams.map((t) => [t.id, t.name])), state.teamId)}
        ${fieldInput('סיסמה זמנית (10 תווים לפחות)', 'password', { required: true, value: tempPassword(), attrs: 'minlength="10"' })}
        <p class="footnote">העבר למנהל את הסיסמה בערוץ מאובטח. בכניסה הראשונה הוא יידרש לבחור סיסמה חדשה. שליחת הזמנה באימייל טרם מומשה.</p>`,
        onSubmit: async (d) => { await api('POST', '/api/admin/users', d); toast('המנהל נוצר'); render(); } });
    },
    'reset-password': (el) => openDialog({ title: 'איפוס סיסמה', body: `${fieldInput('סיסמה זמנית חדשה', 'password', { required: true, value: tempPassword(), attrs: 'minlength="10"' })}
      <p class="footnote">המשתמש ינותק מכל החיבורים ויידרש להחליף סיסמה בכניסה הבאה.</p>`, ok: 'איפוס',
      onSubmit: async (d) => { await api('POST', `/api/admin/users/${el.dataset.id}/password`, d); toast('הסיסמה אופסה'); render(); } }),
    'toggle-user': async (el) => {
      try { await api('PATCH', `/api/admin/users/${el.dataset.id}`, { active: el.dataset.active !== '1' }); toast('המשתמש עודכן'); render(); } catch (e) { toast(errMsg(e), true); }
    },
  };

  function tempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const forms = {
    'activity-new': async (form) => {
      const fd = new FormData(form);
      const metrics = view().players.filter((p) => p.status === 'active').map((p) => ({
        player_id: p.id, distance_km: fd.get(`d_${p.id}`), max_speed_kmh: fd.get(`s_${p.id}`), sprints: fd.get(`p_${p.id}`), minutes: fd.get(`m_${p.id}`),
      })).filter((m) => [m.distance_km, m.max_speed_kmh, m.sprints, m.minutes].some((v) => v && String(v).trim()));
      try {
        await api('POST', `/api/teams/${state.teamId}/activities`, { date: fd.get('date'), kind: fd.get('kind'), title: fd.get('title'), notes: fd.get('notes'), metrics });
        toast('הפעילות נשמרה'); await loadTeamData(); location.hash = '#activities';
      } catch (e) { $('#activity-error').textContent = errMsg(e); }
    },
    'import-check': async (form) => {
      const fd = new FormData(form);
      const file = fd.get('file');
      let text, filename;
      if (file && file.size) {
        if (file.size > 1.5 * 1024 * 1024) return toast('הקובץ גדול מדי (עד 1.5MB)', true);
        text = await file.text(); filename = file.name;
      } else if (state.importPayload && !(state.importPlan && state.importPlan.committed)) {
        ({ csv: text, filename } = state.importPayload);
      } else return toast('יש לבחור קובץ', true);
      state.importPayload = { csv: text, filename, default_date: fd.get('default_date'), default_kind: fd.get('default_kind'),
        create_missing_players: fd.get('create_missing_players') === 'on' };
      try {
        state.importPlan = await api('POST', `/api/teams/${state.teamId}/import/csv`, { ...state.importPayload, dry_run: true });
        await render();
        const pv = $('#import-preview'); if (pv) pv.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { state.importPlan = null; toast(errMsg(e), true); }
    },
    password: async (form) => {
      const d = Object.fromEntries(new FormData(form).entries());
      if (d.new !== d.confirm) { $('#password-error').textContent = 'אימות הסיסמה אינו תואם'; return; }
      try {
        await api('POST', '/api/me/password', { current: d.current, new: d.new });
        await reloadMe(); toast('הסיסמה עודכנה'); form.reset();
        location.hash = '#overview';
      } catch (e) { $('#password-error').textContent = errMsg(e); }
    },
  };

  // ------------------------------------------------------------- wiring
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('#nav a');
    if (nav) $('#app').classList.remove('nav-open');
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      state.rosterSort = { key: k, dir: state.rosterSort.key === k ? -state.rosterSort.dir : (k === 'name' || k === 'number' || k === 'position' ? 1 : -1) };
      return render();
    }
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) {
      if (el.tagName === 'BUTTON' && el.closest('form') && el.closest('#login-form') === null) e.preventDefault();
      actions[el.dataset.action](el, e);
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    forms[f.dataset.form](f);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'roster-q') {
      state.rosterQuery = e.target.value;
      const pos = e.target.selectionStart;
      render().then(() => { const i = $('#roster-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } });
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'roster-pos') { state.rosterPos = t.value; render(); }
    if (t.id === 'roster-archived') { state.rosterArchived = t.checked; render(); }
    if (t.id === 'team-select') { await selectTeam(+t.value); }
    if (t.id === 'period-select') { state.period = t.value; store.set('period', t.value); await refresh(); }
    if (t.dataset.assign) {
      try {
        const r = await api('POST', `/api/teams/${state.teamId}/devices/${t.dataset.assign}/assign`, { player_id: t.value ? +t.value : null });
        state.raw.devices = r.devices; toast('השיוך עודכן'); render();
      } catch (err) { toast(errMsg(err), true); render(); }
    }
  });
  window.addEventListener('hashchange', () => {
    if (!state.backend) return;
    if (location.hash === '#login') return showLogin();
    render(); window.scrollTo(0, 0);
  });

  async function selectTeam(id) {
    state.teamId = id; store.set('team', id);
    state.compare = []; state.importPlan = null; state.openActivity = null;
    await refresh();
  }

  // ------------------------------------------------------------- boot
  async function startApp() {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    $('#period-select').value = state.period;
    try { await loadTeamData(); } catch (e) { toast(errMsg(e), true); }
    if (location.hash === '#login') location.hash = '#overview';
    render();
  }
  async function startDemo() {
    state.backend = window.ANOXDemo.createBackend();
    state.teamId = null;
    await reloadMe();
    return startApp();
  }
  function showLogin() {
    $('#app').hidden = true;
    $('#login-screen').hidden = false;
    const canLogin = location.protocol !== 'file:';
    $('#login-error').textContent = canLogin ? '' : 'כניסה לחשבון דורשת הפעלת השרת: python3 server.py, ולאחר מכן פתיחת http://127.0.0.1:8001';
    $('#login-form [type=submit]').disabled = !canLogin;
    if (canLogin) $('#login-form [name=email]').focus();
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = $('#login-form [type=submit]');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      await remote.request('POST', '/api/login', { email: fd.get('email'), password: fd.get('password') });
      state.backend = remote; state.teamId = null; state.raw = null;
      await reloadMe();
      e.target.reset();
      if (location.hash === '#login') location.hash = '';
      await startApp();
    } catch (err) {
      $('#login-error').textContent = errMsg(err);
    } finally { btn.disabled = false; }
  });

  (async function boot() {
    if (location.protocol === 'file:') return startDemo();
    try {
      state.backend = remote;
      await reloadMe();
      return startApp();
    } catch (e) {
      if (location.hash === '#login') { state.backend = null; return showLogin(); }
      return startDemo();
    }
  })();
})();

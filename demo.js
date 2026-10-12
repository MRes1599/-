/* ANOX — demo backend.
 * Runs entirely in memory and mirrors the server API so the same UI works without a server.
 * Every generated activity is tagged source "demo". Nothing persists; a refresh resets everything.
 */
(function () {
  'use strict';

  const LIMITS = { distance_km: [0, 20], max_speed_kmh: [0, 45], sprints: [0, 200], minutes: [0, 240] };
  const METRIC_LABELS = { distance_km: 'מרחק (ק״מ)', max_speed_kmh: 'מהירות שיא (קמ״ש)', sprints: 'ספרינטים', minutes: 'דקות' };
  const POSITION_ALIASES = {
    gk: 'GK', 'שוער': 'GK', def: 'DEF', df: 'DEF', 'הגנה': 'DEF', 'מגן': 'DEF', 'בלם': 'DEF',
    mid: 'MID', mf: 'MID', 'קישור': 'MID', 'קשר': 'MID', fwd: 'FWD', fw: 'FWD', 'התקפה': 'FWD', 'חלוץ': 'FWD',
  };
  const KIND_ALIASES = { training: 'training', 'אימון': 'training', match: 'match', 'משחק': 'match' };
  const HEADER_ALIASES = {
    date: 'date', 'תאריך': 'date', type: 'type', kind: 'type', 'סוג': 'type', title: 'title', session: 'title',
    'כותרת': 'title', name: 'name', 'שם': 'name', position: 'position', 'עמדה': 'position', number: 'number',
    'מספר': 'number', distance: 'distance', 'מרחק': 'distance', speed: 'speed', max_speed: 'speed',
    'מהירות': 'speed', sprints: 'sprints', 'ספרינטים': 'sprints', minutes: 'minutes', 'דקות': 'minutes',
    source: 'source', 'מקור': 'source',
  };

  class DemoError extends Error {
    constructor(status, message) { super(message); this.status = status; this.error = message; }
  }
  const bad = (m) => new DemoError(400, m);

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  const iso = (d) => d.toISOString().slice(0, 10);
  const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const normName = (s) => s.trim().split(/\s+/).join(' ').toLowerCase();

  function parsePosition(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (['GK', 'DEF', 'MID', 'FWD'].includes(s.toUpperCase())) return s.toUpperCase();
    return POSITION_ALIASES[s.toLowerCase()] || null;
  }
  function parseKind(v) { return v == null ? null : KIND_ALIASES[String(v).trim().toLowerCase()] || null; }
  function parseDate(v) {
    if (typeof v !== 'string') throw bad('תאריך לא תקין');
    let s = v.trim();
    const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (m) s = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad('תאריך לא תקין (נדרש YYYY-MM-DD)');
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    if (s > iso(tomorrow) || s < '2000-01-01') throw bad('תאריך לא תקין (לא בעתיד)');
    return s;
  }
  function parseNumber(v) {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    if (!Number.isInteger(n)) throw bad('מספר חולצה חייב להיות מספר שלם');
    if (n < 1 || n > 99) throw bad('מספר חולצה חייב להיות בין 1 ל-99');
    return n;
  }
  function parseMetric(v, key) {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).trim().replace(',', '.'));
    const label = METRIC_LABELS[key];
    if (!Number.isFinite(n)) throw bad(`${label}: ערך לא מספרי`);
    const [lo, hi] = LIMITS[key];
    if (n < lo || n > hi) throw bad(`${label}: ערך מחוץ לטווח (${lo}–${hi})`);
    if (key === 'sprints') { if (!Number.isInteger(n)) throw bad(`${label}: חייב להיות מספר שלם`); return n; }
    return Math.round(n * 100) / 100;
  }
  function parseMetrics(raw) {
    const out = {};
    for (const k of Object.keys(LIMITS)) out[k] = parseMetric(raw[k], k);
    return Object.values(out).every((v) => v == null) ? null : out;
  }
  function cleanText(v, field, max, required = true) {
    const s = (v == null ? '' : String(v)).trim().split(/\s+/).join(' ');
    if (required && !s) throw bad(`השדה ${field} חובה`);
    if (s.length > max) throw bad(`השדה ${field} ארוך מדי`);
    return s;
  }

  function splitCsvLine(line, delim) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  }

  // ------------------------------------------------------------- seed data
  const ROSTER = [
    ['עומר לוי', 'GK'], ['איתי כהן', 'DEF'], ['נועם פרץ', 'DEF'], ['יונתן מזרחי', 'DEF'], ['אורי ביטון', 'DEF'],
    ['דניאל אברהם', 'MID'], ['רועי שפירא', 'MID'], ['אלון דהן', 'MID'], ['תומר גבאי', 'MID'],
    ['ליאור חדד', 'FWD'], ['עידו אזולאי', 'FWD'], ['שחר מלכה', 'FWD'], ['אביב סעדה', 'MID'], ['גיל אוחיון', 'DEF'],
  ];
  const BASE = { GK: 4.6, DEF: 8.7, MID: 9.9, FWD: 9.0 };

  function seed() {
    const db = { teams: [], users: [], players: [], activities: [], devices: [], imports: [], audit: [], seq: 1 };
    const id = () => db.seq++;
    const teams = [
      ['קבוצת הדגמה א׳ — נוער', 'paid', 1.0], ['קבוצת הדגמה ב׳ — ילדים', 'trial', 0.82], ['קבוצת הדגמה ג׳ — בוגרים', 'pilot', 1.08],
    ];
    teams.forEach(([name, plan, scale], ti) => {
      const r = rng(11 + ti * 97);
      const team = { id: id(), name, status: 'active', plan, is_demo: true, created_at: nowIso() };
      db.teams.push(team);
      db.users.push({ id: id(), email: `manager${ti + 1}@demo.anox`, name: `מנהל הדגמה ${ti + 1}`, role: 'manager',
        team_id: team.id, active: true, must_change_password: false, created_at: nowIso(), last_login_at: null });
      const players = ROSTER.slice(0, 12 + ti).map(([n, pos], i) => {
        const p = { id: id(), team_id: team.id, name: n, position: pos, number: i + 1, status: 'active', created_at: nowIso(),
          _form: 0.9 + r() * 0.2 };
        db.players.push(p);
        return p;
      });
      const start = new Date(); start.setDate(start.getDate() - 83);
      for (let day = 0; day < 84; day++) {
        const d = new Date(start); d.setDate(start.getDate() + day);
        const wd = d.getDay();
        if (![0, 2, 3, 5].includes(wd)) continue;
        const kind = wd === 5 ? 'match' : 'training';
        const trend = 0.94 + (day / 84) * 0.1;
        const metrics = players.filter(() => r() > 0.08).map((p) => {
          const k = kind === 'match' ? 1.15 : 0.72;
          const minutes = kind === 'match' ? (r() > 0.3 ? 90 : 45 + Math.round(r() * 40)) : [70, 75, 80][Math.floor(r() * 3)];
          return {
            player_id: p.id,
            distance_km: Math.round(BASE[p.position] * k * scale * p._form * trend * (0.86 + r() * 0.24) * (minutes / 90 * 0.6 + 0.4) * 100) / 100,
            max_speed_kmh: Math.round((p.position === 'GK' ? 24 : 29.5) * scale ** 0.3 * (0.9 + r() * 0.16) * 10) / 10,
            sprints: p.position === 'GK' ? null : Math.round((kind === 'match' ? 14 : 8) * p._form * (0.6 + r() * 0.8)),
            minutes,
          };
        });
        db.activities.push({ id: id(), team_id: team.id, date: iso(d), kind, title: kind === 'match' ? 'משחק ליגה' : 'אימון קבוצתי',
          source: 'demo', import_batch_id: null, notes: '', created_at: nowIso(), metrics });
      }
      for (let i = 0; i < 4; i++) {
        db.devices.push({ id: id(), team_id: team.id, label: `AT01-${String(i + 1).padStart(2, '0')}`, serial: null, model: 'AT01',
          status: 'active', created_at: nowIso(), player_id: players[i + 5].id, assigned_at: nowIso() });
      }
    });
    db.players.forEach((p) => delete p._form);
    return db;
  }

  // ------------------------------------------------------------- backend
  function createBackend() {
    const db = seed();
    const nextId = () => db.seq++;
    const me = { id: 0, email: 'demo@anox', name: 'משתמש הדגמה', role: 'owner', team_id: null, must_change_password: false };
    const log = (team_id, action, detail = {}) =>
      db.audit.unshift({ id: nextId(), at: nowIso(), user_id: 0, user_email: me.email, team_id,
        team_name: (db.teams.find((t) => t.id === team_id) || {}).name || null, action, detail });

    const team = (tid) => {
      const t = db.teams.find((x) => x.id === tid);
      if (!t) throw new DemoError(404, 'הקבוצה לא נמצאה');
      return t;
    };
    const activePlayers = (tid) => db.players.filter((p) => p.team_id === tid && p.status === 'active');
    const numberFree = (tid, number, exclude) => {
      if (number == null) return;
      const p = activePlayers(tid).find((x) => x.number === number && x.id !== exclude);
      if (p) throw new DemoError(409, `מספר ${number} כבר משויך לשחקן ${p.name}`);
    };
    const addPlayer = (tid, name, position, number) => {
      numberFree(tid, number);
      const p = { id: nextId(), team_id: tid, name, position, number, status: 'active', created_at: nowIso() };
      db.players.push(p);
      return p;
    };
    const publicPlayer = (p) => ({ id: p.id, name: p.name, position: p.position, number: p.number, status: p.status, created_at: p.created_at });

    function planCsv(tid, text, defDate, defKind, createMissing) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) throw bad('הקובץ חייב לכלול שורת כותרות ולפחות שורת נתונים אחת');
      const delim = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
      const header = splitCsvLine(lines[0], delim).map((h) => HEADER_ALIASES[h.trim().toLowerCase()] || null);
      const missing = ['distance', 'minutes', 'name', 'speed'].filter((k) => !header.includes(k));
      if (missing.length) throw bad('עמודות חסרות בקובץ: ' + missing.join(', '));
      if (!header.includes('date') && !defDate) throw bad('בקובץ אין עמודת date — יש לבחור תאריך לפעילות');
      if (defDate) defDate = parseDate(defDate);
      defKind = parseKind(defKind) || 'training';
      const players = activePlayers(tid);
      const errors = []; const newPlayers = new Map(); const groups = new Map();
      lines.slice(1).forEach((line, i) => {
        const rec = {};
        splitCsvLine(line, delim).forEach((c, j) => { if (header[j]) rec[header[j]] = c.trim(); });
        try {
          const name = cleanText(rec.name, 'name', 80);
          const date = rec.date ? parseDate(rec.date) : defDate;
          const kind = rec.type ? parseKind(rec.type) : defKind;
          if (!kind) throw bad('סוג פעילות לא מוכר (training/match או אימון/משחק)');
          const title = cleanText(rec.title || '', 'title', 120, false);
          const number = parseNumber(rec.number);
          const position = rec.position ? parsePosition(rec.position) : null;
          if (rec.position && !position) throw bad('עמדה לא מוכרת (GK/DEF/MID/FWD או שוער/הגנה/קישור/התקפה)');
          const metrics = parseMetrics({ distance_km: rec.distance, max_speed_kmh: rec.speed, sprints: rec.sprints, minutes: rec.minutes });
          if (!metrics) throw bad('אין ערכי ביצוע בשורה');
          let key = null;
          const byNum = number != null && players.find((p) => p.number === number);
          if (byNum) {
            if (normName(byNum.name) !== normName(name)) throw bad(`מספר ${number} משויך בסגל לשחקן ${byNum.name}, לא ל-${name}`);
            key = 'id:' + byNum.id;
          } else {
            const matches = players.filter((p) => normName(p.name) === normName(name));
            if (matches.length === 1) {
              if (number != null && matches[0].number != null && matches[0].number !== number)
                throw bad(`${name} רשום בסגל עם מספר ${matches[0].number}, בקובץ מופיע ${number}`);
              key = 'id:' + matches[0].id;
            } else if (matches.length > 1) throw bad(`יש בסגל יותר משחקן אחד בשם ${name} — הוסף מספר חולצה`);
          }
          if (!key) {
            if (!createMissing) throw bad(`השחקן ${name} לא נמצא בסגל`);
            if (!position) throw bad(`כדי ליצור את ${name} כשחקן חדש נדרשת עמדה`);
            const nk = normName(name);
            if (newPlayers.has(nk)) { if (newPlayers.get(nk).number !== number) throw bad(`מספר חולצה לא עקבי עבור ${name}`); }
            else {
              if (number != null && [...newPlayers.values()].some((x) => x.number === number)) throw bad(`מספר ${number} מופיע אצל שני שחקנים חדשים`);
              newPlayers.set(nk, { name, position, number });
            }
            key = 'new:' + nk;
          }
          const gk = [date, kind, title].join('|');
          if (!groups.has(gk)) groups.set(gk, { date, kind, title, rows: new Map() });
          const g = groups.get(gk);
          if (g.rows.has(key)) throw bad(`${name} מופיע פעמיים באותה פעילות`);
          g.rows.set(key, metrics);
        } catch (e) {
          if (!(e instanceof DemoError)) throw e;
          errors.push({ line: i + 2, message: e.error });
        }
      });
      const warnings = [];
      for (const g of groups.values()) {
        if (db.activities.some((a) => a.team_id === tid && a.date === g.date && a.kind === g.kind && a.title === g.title))
          warnings.push(`כבר קיימת פעילות בתאריך ${g.date} עם אותו סוג וכותרת — ייתכן ייבוא כפול`);
      }
      return {
        errors, warnings, new_players: [...newPlayers.values()], row_count: lines.length - 1,
        activities: [...groups.values()].sort((a, b) => a.date.localeCompare(b.date))
          .map((g) => ({ date: g.date, kind: g.kind, title: g.title, players: g.rows.size })),
        _groups: groups,
      };
    }

    const routes = [
      ['GET', /^\/api\/me$/, () => ({ user: me, teams: clone(db.teams) })],
      ['GET', /^\/api\/teams\/(\d+)\/data$/, (m, b, q) => {
        const t = team(+m[1]);
        const acts = db.activities.filter((a) => a.team_id === t.id && (!q.from || a.date >= q.from) && (!q.to || a.date <= q.to))
          .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
        return { team: clone(t), players: db.players.filter((p) => p.team_id === t.id).map(publicPlayer),
          activities: clone(acts), devices: clone(db.devices.filter((d) => d.team_id === t.id)) };
      }],
      ['POST', /^\/api\/teams\/(\d+)\/players$/, (m, b) => {
        const t = team(+m[1]);
        const pos = parsePosition(b.position);
        if (!pos) throw bad('יש לבחור עמדה');
        const p = addPlayer(t.id, cleanText(b.name, 'שם השחקן', 80), pos, parseNumber(b.number));
        log(t.id, 'player.create', { name: p.name });
        return { player: publicPlayer(p) };
      }],
      ['PATCH', /^\/api\/teams\/(\d+)\/players\/(\d+)$/, (m, b) => {
        const t = team(+m[1]);
        const p = db.players.find((x) => x.id === +m[2] && x.team_id === t.id);
        if (!p) throw new DemoError(404, 'השחקן לא נמצא');
        const ch = {};
        if ('name' in b) ch.name = cleanText(b.name, 'שם השחקן', 80);
        if ('position' in b) { ch.position = parsePosition(b.position); if (!ch.position) throw bad('עמדה לא תקינה'); }
        if ('number' in b) ch.number = parseNumber(b.number);
        if ('status' in b) ch.status = b.status;
        const st = ch.status || p.status; const num = 'number' in ch ? ch.number : p.number;
        if (st === 'active') numberFree(t.id, num, p.id);
        if (ch.status === 'archived') db.devices.forEach((d) => { if (d.player_id === p.id) { d.player_id = null; d.assigned_at = null; } });
        Object.assign(p, ch);
        log(t.id, 'player.update', { player: p.name, changes: ch });
        return { player: publicPlayer(p) };
      }],
      ['POST', /^\/api\/teams\/(\d+)\/activities$/, (m, b) => {
        const t = team(+m[1]);
        const date = parseDate(b.date);
        const kind = parseKind(b.kind);
        if (!kind) throw bad('יש לבחור סוג פעילות');
        const ids = new Set(activePlayers(t.id).map((p) => p.id));
        const metrics = [];
        for (const e of b.metrics || []) {
          if (!ids.has(+e.player_id)) throw bad('שחקן לא שייך לסגל הפעיל של הקבוצה');
          const mm = parseMetrics(e);
          if (mm) metrics.push({ player_id: +e.player_id, ...mm });
        }
        if (!metrics.length) throw bad('יש להזין נתונים לפחות לשחקן אחד');
        const a = { id: nextId(), team_id: t.id, date, kind, title: cleanText(b.title, 'כותרת', 120, false), source: 'manual',
          import_batch_id: null, notes: cleanText(b.notes, 'הערות', 1000, false), created_at: nowIso(), metrics };
        db.activities.push(a);
        log(t.id, 'activity.create', { date });
        return { activity_id: a.id };
      }],
      ['DELETE', /^\/api\/teams\/(\d+)\/activities\/(\d+)$/, (m) => {
        const i = db.activities.findIndex((a) => a.id === +m[2] && a.team_id === +m[1]);
        if (i < 0) throw new DemoError(404, 'הפעילות לא נמצאה');
        log(+m[1], 'activity.delete', { date: db.activities[i].date });
        db.activities.splice(i, 1);
        return { ok: true };
      }],
      ['POST', /^\/api\/teams\/(\d+)\/import\/csv$/, (m, b) => {
        const t = team(+m[1]);
        const plan = planCsv(t.id, String(b.csv || ''), b.default_date, b.default_kind, !!b.create_missing_players);
        const { _groups, ...pub } = plan;
        if (b.dry_run || plan.errors.length) return { ...pub, committed: false };
        const created = new Map();
        plan.new_players.forEach((p) => created.set(normName(p.name), addPlayer(t.id, p.name, p.position, p.number).id));
        const batch = { id: nextId(), team_id: t.id, source: 'csv', filename: b.filename || '', row_count: plan.row_count,
          created_by_name: me.name, created_at: nowIso() };
        db.imports.unshift(batch);
        for (const g of _groups.values()) {
          const metrics = [...g.rows.entries()].map(([k, mm]) => ({
            player_id: k.startsWith('id:') ? +k.slice(3) : created.get(k.slice(4)), ...mm }));
          db.activities.push({ id: nextId(), team_id: t.id, date: g.date, kind: g.kind, title: g.title, source: 'csv',
            import_batch_id: batch.id, notes: '', created_at: nowIso(), metrics });
        }
        log(t.id, 'import.csv', { filename: batch.filename, rows: plan.row_count });
        return { ...pub, committed: true, batch_id: batch.id };
      }],
      ['GET', /^\/api\/teams\/(\d+)\/imports$/, (m) => ({
        imports: db.imports.filter((i) => i.team_id === +m[1]).map((i) => ({
          ...i, activities: db.activities.filter((a) => a.import_batch_id === i.id).length })) })],
      ['DELETE', /^\/api\/teams\/(\d+)\/imports\/(\d+)$/, (m) => {
        const i = db.imports.findIndex((x) => x.id === +m[2] && x.team_id === +m[1]);
        if (i < 0) throw new DemoError(404, 'הייבוא לא נמצא');
        db.activities = db.activities.filter((a) => a.import_batch_id !== +m[2]);
        db.imports.splice(i, 1);
        log(+m[1], 'import.undo', {});
        return { ok: true };
      }],
      ['POST', /^\/api\/teams\/(\d+)\/devices$/, (m, b) => {
        const t = team(+m[1]);
        const d = { id: nextId(), team_id: t.id, label: cleanText(b.label, 'תווית', 40), serial: cleanText(b.serial, 'מספר סידורי', 80, false) || null,
          model: 'AT01', status: 'active', created_at: nowIso(), player_id: null, assigned_at: null };
        db.devices.push(d);
        return { device_id: d.id };
      }],
      ['POST', /^\/api\/teams\/(\d+)\/devices\/(\d+)\/assign$/, (m, b) => {
        const tid = +m[1];
        const d = db.devices.find((x) => x.id === +m[2] && x.team_id === tid);
        if (!d) throw new DemoError(404, 'המכשיר לא נמצא');
        const pid = b.player_id == null ? null : +b.player_id;
        if (pid != null) {
          if (!activePlayers(tid).some((p) => p.id === pid)) throw bad('שחקן לא תקין');
          db.devices.forEach((x) => { if (x.player_id === pid) { x.player_id = null; x.assigned_at = null; } });
        }
        d.player_id = pid; d.assigned_at = pid ? nowIso() : null;
        return { devices: clone(db.devices.filter((x) => x.team_id === tid)) };
      }],
      ['GET', /^\/api\/admin\/teams$/, () => ({ teams: db.teams.map((t) => {
        const acts = db.activities.filter((a) => a.team_id === t.id);
        return { ...t, players: activePlayers(t.id).length, activities: acts.length,
          last_activity: acts.map((a) => a.date).sort().pop() || null,
          managers: db.users.filter((u) => u.team_id === t.id && u.active).length };
      }) })],
      ['POST', /^\/api\/admin\/teams$/, (m, b) => {
        const t = { id: nextId(), name: cleanText(b.name, 'שם הקבוצה', 80), status: 'active', plan: b.plan || 'pilot',
          is_demo: true, created_at: nowIso() };
        db.teams.push(t);
        log(t.id, 'team.create', { name: t.name });
        return { team: clone(t) };
      }],
      ['PATCH', /^\/api\/admin\/teams\/(\d+)$/, (m, b) => {
        const t = team(+m[1]);
        ['name', 'plan', 'status'].forEach((k) => { if (k in b) t[k] = k === 'name' ? cleanText(b.name, 'שם הקבוצה', 80) : b[k]; });
        log(t.id, 'team.update', b);
        return { team: clone(t) };
      }],
      ['GET', /^\/api\/admin\/users$/, () => ({ users: [{ ...me, active: true, created_at: nowIso(), last_login_at: nowIso() }, ...clone(db.users)] })],
      ['POST', /^\/api\/admin\/users$/, (m, b) => {
        const email = cleanText(b.email, 'אימייל', 200).toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('כתובת אימייל לא תקינה');
        if (!b.password || String(b.password).length < 10) throw bad('הסיסמה חייבת להכיל לפחות 10 תווים');
        if (db.users.some((u) => u.email === email)) throw new DemoError(409, 'קיים כבר משתמש עם אימייל זה');
        const u = { id: nextId(), email, name: cleanText(b.name, 'שם', 80), role: 'manager', team_id: team(+b.team_id).id,
          active: true, must_change_password: true, created_at: nowIso(), last_login_at: null };
        db.users.push(u);
        log(u.team_id, 'user.create', { email });
        return { user: clone(u) };
      }],
      ['PATCH', /^\/api\/admin\/users\/(\d+)$/, (m, b) => {
        const u = db.users.find((x) => x.id === +m[1]);
        if (!u) throw new DemoError(404, 'המשתמש לא נמצא');
        if ('active' in b) u.active = !!b.active;
        if ('name' in b) u.name = cleanText(b.name, 'שם', 80);
        if ('team_id' in b) u.team_id = team(+b.team_id).id;
        return { user: clone(u) };
      }],
      ['POST', /^\/api\/admin\/users\/(\d+)\/password$/, (m, b) => {
        if (!b.password || String(b.password).length < 10) throw bad('הסיסמה חייבת להכיל לפחות 10 תווים');
        return { ok: true };
      }],
      ['GET', /^\/api\/admin\/audit$/, () => ({ entries: clone(db.audit) })],
      ['POST', /^\/api\/me\/password$/, () => { throw bad('במצב הדגמה אין סיסמה לשינוי'); }],
    ];

    function exportCsv(tid) {
      const players = new Map(db.players.filter((p) => p.team_id === tid).map((p) => [p.id, p]));
      const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const rows = [['date', 'type', 'title', 'source', 'name', 'position', 'number', 'distance', 'speed', 'sprints', 'minutes']];
      db.activities.filter((a) => a.team_id === tid).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).forEach((a) => {
        a.metrics.forEach((mm) => {
          const p = players.get(mm.player_id);
          rows.push([a.date, a.kind, a.title, a.source, p.name, p.position, p.number, mm.distance_km, mm.max_speed_kmh, mm.sprints, mm.minutes]);
        });
      });
      return '﻿' + rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
    }

    return {
      mode: 'demo',
      exportCsv,
      request(method, url, body) {
        const [path, qs] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(qs || ''));
        for (const [m, rx, fn] of routes) {
          const match = m === method && path.match(rx);
          if (match) {
            try { return Promise.resolve(clone(fn(match, body || {}, query) || {})); } catch (e) { return Promise.reject(e); }
          }
        }
        return Promise.reject(new DemoError(404, 'הפעולה אינה זמינה במצב הדגמה'));
      },
    };
  }

  window.ANOXDemo = { createBackend };
})();

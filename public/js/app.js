'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id) => `<svg class="icon"><use href="#i-${id}"/></svg>`;

  const STATUS_LABEL = {
    idle: 'Livre', inuse: 'Em ligação', busy: 'Ocupado', ringing: 'Tocando', onhold: 'Em espera', unavailable: 'Indisponível',
  };
  const ROLE_LABEL = { admin: 'Administrador', operator: 'Operador', user: 'Usuário' };

  const state = {
    me: null,
    pbx: { connected: false, extensions: [], calls: [] },
    clockOffset: 0,
    filter: 'all',
    search: '',
    view: 'painel',
    users: [],
    editingUser: null,
    transferCall: null,
    ws: null,
  };

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') showLogin();
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' ? 'err' : ''}`;
    el.innerHTML = `${icon(type === 'err' ? 'x' : 'check')}<span>${esc(message)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  const initials = (name, fallback) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return esc(String(fallback || '?').slice(-2));
    return esc((parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase());
  };

  const fmtDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  };
  const now = () => Date.now() + state.clockOffset;

  // ---------- Sessão ----------
  function showLogin() {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    state.me = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-user').focus();
  }

  function showApp() {
    const me = state.me;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#me-name').textContent = me.name;
    $('#me-role').textContent = ROLE_LABEL[me.role] || me.role;
    $('#me-avatar').innerHTML = initials(me.name);
    $('#me-ext').textContent = me.extension || '—';
    $('#call-hint').textContent = me.extension
      ? `Clique em um ramal para ligar a partir do seu ramal ${me.extension}`
      : 'Seu usuário não possui ramal discador. Peça ao administrador para associar um ramal.';
    $$('[data-admin]').forEach((el) => { el.hidden = me.role !== 'admin'; });
    $$('[data-has-ext]').forEach((el) => { el.hidden = !me.extension; });
    $('#h-ext').textContent = me.extension || '—';
    connectWs();
    route();
    handleCallParam();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const { user } = await api('POST', '/api/login', {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      });
      $('#login-pass').value = '';
      state.me = user;
      // Perfil "Usuário" sempre entra direto no painel do switchboard
      if (user.role === 'user') history.replaceState(null, '', `${location.pathname}${location.search}#painel`);
      showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    showLogin();
  });

  // ---------- Tempo real ----------
  function connectWs() {
    if (state.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    state.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        state.pbx = msg.data;
        state.clockOffset = msg.data.serverTime - Date.now();
        renderPbx();
      }
    };
    ws.onclose = (ev) => {
      state.ws = null;
      setConn(false, 'Reconectando…');
      if (ev.code === 4001) return showLogin();
      // Confere se a sessão ainda é válida antes de reconectar
      setTimeout(() => state.me && api('GET', '/api/me').then(() => connectWs()).catch(() => {}), 2000);
    };
  }

  function setConn(on, text) {
    const el = $('#conn');
    el.className = `conn ${on ? 'on' : 'off'}`;
    $('.txt', el).textContent = text;
  }

  // ---------- Painel ----------
  function renderPbx() {
    const { extensions, calls, connected } = state.pbx;
    setConn(connected, connected ? 'PABX conectado' : 'PABX desconectado');

    const count = (fn) => extensions.filter(fn).length;
    $('#k-free').textContent = count((e) => e.status === 'idle');
    $('#k-busy').textContent = count((e) => ['inuse', 'busy', 'onhold'].includes(e.status));
    $('#k-ring').textContent = count((e) => e.status === 'ringing');
    $('#k-calls').textContent = calls.length;

    renderExtensions();
    renderCalls();
    $('#ext-options').innerHTML = extensions
      .map((e) => `<option value="${esc(e.exten)}">${esc(e.name || '')}</option>`)
      .join('');
  }

  function statusGroup(s) {
    return s === 'busy' || s === 'onhold' ? 'inuse' : s;
  }

  function renderExtensions() {
    const q = state.search.toLowerCase();
    const list = state.pbx.extensions.filter((e) =>
      (state.filter === 'all' || statusGroup(e.status) === state.filter) &&
      (!q || e.exten.includes(q) || (e.name || '').toLowerCase().includes(q))
    );
    const grid = $('#ext-grid');
    if (!list.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon('search')}<div>${
        state.pbx.extensions.length ? 'Nenhum ramal encontrado' : 'Aguardando dados do PABX…'
      }</div></div>`;
      return;
    }
    const myExt = state.me && state.me.extension;
    grid.innerHTML = list.map((e) => {
      const mine = e.exten === myExt;
      const canCall = !mine && myExt && e.status !== 'unavailable';
      // Nome igual ao número do ramal (comum no Issabel) é tratado como "sem nome"
      const name = e.name && e.name !== e.exten ? e.name : '';
      const peer = e.call
        ? `<span class="peer">${icon('phone')} ${esc(e.call.peer)} · <span data-since="${e.call.since}">${fmtDuration(now() - e.call.since)}</span></span>`
        : `<span class="pill">${esc(STATUS_LABEL[e.status] || e.status)}</span>`;
      const title = canCall ? `Clique para ligar para ${name || `o ramal ${e.exten}`}` : mine ? 'Seu ramal' : '';
      return `<div class="ext st-${esc(e.status)}${mine ? ' mine' : ''}${canCall ? ' callable' : ''}"
        data-ext="${esc(e.exten)}" ${canCall ? 'role="button" tabindex="0"' : ''} title="${esc(title)}"
        aria-label="${esc(`${name || 'Ramal'} ${e.exten}, ${STATUS_LABEL[e.status] || e.status}`)}">
        <div class="ext-top">
          <div class="avatar">${initials(name, e.exten)}<span class="st"></span></div>
          <div class="ext-info"><div class="ext-name">${esc(name || `Ramal ${e.exten}`)}${mine ? ' <small class="ext-num">(você)</small>' : ''}</div><div class="ext-num">${name ? `Ramal ${esc(e.exten)}` : '&nbsp;'}</div></div>
        </div>
        <div class="ext-bottom">${peer}<span class="call-ic" aria-hidden="true">${icon('phone')}</span></div>
      </div>`;
    }).join('');
  }

  function renderCalls() {
    const calls = state.pbx.calls;
    $('#calls-count').textContent = calls.length;
    const el = $('#calls');
    if (!calls.length) {
      el.innerHTML = `<div class="empty">${icon('phone')}<div>Nenhuma chamada em andamento</div></div>`;
      return;
    }
    const me = state.me;
    const canManage = (c) => me.role !== 'user' || (me.extension && c.extensions.includes(me.extension));
    el.innerHTML = calls.map((c) => {
      const since = c.answeredAt || c.startedAt;
      const up = c.state === 'up';
      return `<div class="call">
        <div class="call-parties">
          <div class="party"><b>${esc(c.fromName || c.from || 'Desconhecido')}</b><span>${esc(c.from)}</span></div>
          <svg class="icon call-arrow"><use href="#i-arrow"/></svg>
          <div class="party right"><b>${esc(c.toName || c.to || '—')}</b><span>${esc(c.to)}</span></div>
        </div>
        <div class="call-meta">
          <span class="pill ${up ? 'st-inuse' : 'st-ringing'}">${up ? 'Em ligação' : 'Chamando'} · <span class="timer" data-since="${since}">${fmtDuration(now() - since)}</span></span>
          ${canManage(c) ? `<div class="call-actions">
            <button class="btn btn-teal" type="button" data-transfer="${esc(c.id)}" title="Transferir">${icon('transfer')}</button>
            <button class="btn btn-danger" type="button" data-hangup="${esc(c.id)}" title="Desligar">${icon('phone-off')}</button>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // Atualiza cronômetros sem re-renderizar tudo
  setInterval(() => {
    $$('[data-since]').forEach((el) => { el.textContent = fmtDuration(now() - Number(el.dataset.since)); });
  }, 1000);

  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderExtensions();
  });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderExtensions(); });

  // ---------- Click to call ----------
  const dialing = new Set(); // evita disparar a mesma chamada várias vezes seguidas

  async function clickToCall(number) {
    number = String(number || '').trim();
    if (!number || dialing.has(number)) return;
    dialing.add(number);
    try {
      const res = await api('POST', '/api/call', { number });
      toast(`Seu ramal ${res.extension} vai tocar. Atenda para ligar para ${res.number}.`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setTimeout(() => dialing.delete(number), 4000);
    }
  }

  // Clique em um card de ramal: liga do ramal do usuário para aquele ramal
  function callExtension(card) {
    const ext = card.dataset.ext;
    if (card.classList.contains('callable')) return clickToCall(ext);
    if (!state.me.extension) return toast('Seu usuário não possui ramal discador. Peça ao administrador para associar um ramal.', 'err');
    if (ext === state.me.extension) return;
    toast(`Ramal ${ext} indisponível no momento`, 'err');
  }

  $('#ext-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.ext[data-ext]');
    if (card) callExtension(card);
  });
  $('#ext-grid').addEventListener('keydown', (e) => {
    const card = e.target.closest('.ext.callable');
    if (card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      callExtension(card);
    }
  });

  document.addEventListener('click', (e) => {
    const call = e.target.closest('[data-call]');
    if (call && !call.disabled) {
      clickToCall(call.dataset.call);
      return;
    }
    const hang = e.target.closest('[data-hangup]');
    if (hang) {
      api('POST', `/api/calls/${encodeURIComponent(hang.dataset.hangup)}/hangup`)
        .then(() => toast('Chamada encerrada'))
        .catch((err) => toast(err.message, 'err'));
      return;
    }
    const tr = e.target.closest('[data-transfer]');
    if (tr) openTransfer(tr.dataset.transfer);
  });

  // Link direto: /?call=11999990000 (ex.: integração com CRM)
  function handleCallParam() {
    const params = new URLSearchParams(location.search);
    let number = params.get('call');
    if (!number) return;
    number = number.replace(/^tel:/i, '');
    history.replaceState(null, '', location.pathname + location.hash);
    if (state.me.extension && confirm(`Ligar para ${number} pelo ramal ${state.me.extension}?`)) clickToCall(number);
  }

  // ---------- Transferência ----------
  function openTransfer(callId) {
    state.transferCall = callId;
    $('#transfer-error').textContent = '';
    $('#t-target').value = '';
    $('#transfer-modal').hidden = false;
    $('#t-target').focus();
  }
  $('#transfer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/calls/${encodeURIComponent(state.transferCall)}/transfer`, { target: $('#t-target').value });
      $('#transfer-modal').hidden = true;
      toast('Chamada transferida');
    } catch (err) {
      $('#transfer-error').textContent = err.message;
    }
  });

  // ---------- Usuários ----------
  async function loadUsers() {
    try {
      state.users = (await api('GET', '/api/users')).users;
      renderUsers();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function renderUsers() {
    const extName = (x) => (state.pbx.extensions.find((e) => e.exten === x) || {}).name;
    $('#users-body').innerHTML = state.users.map((u) => `<tr>
      <td><div class="me-row"><div class="avatar">${initials(u.name)}</div><b>${esc(u.name)}</b></div></td>
      <td>${esc(u.username)}</td>
      <td>${u.extension ? `<span class="badge ramal">${esc(u.extension)}</span> <span class="hint">${esc(extName(u.extension) || '')}</span>` : '<span class="hint">—</span>'}</td>
      <td><span class="badge ${esc(u.role)}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td>${u.active ? '<span class="badge">Ativo</span>' : '<span class="badge inactive">Inativo</span>'}</td>
      <td style="text-align:right">
        <button class="btn btn-icon btn-ghost" type="button" data-edit-user="${esc(u.id)}" title="Editar">${icon('edit')}</button>
        ${u.id === state.me.id ? '' : `<button class="btn btn-icon btn-ghost" type="button" data-del-user="${esc(u.id)}" title="Excluir">${icon('trash')}</button>`}
      </td>
    </tr>`).join('');
  }

  function openUserModal(user) {
    state.editingUser = user || null;
    const f = $('#user-form');
    f.reset();
    $('#user-error').textContent = '';
    $('#user-modal-title').textContent = user ? 'Editar usuário' : 'Novo usuário';
    $('#u-password').required = !user;
    $('#u-password').placeholder = user ? 'Deixe em branco para manter' : '';
    if (user) {
      $('#u-name').value = user.name;
      $('#u-username').value = user.username;
      $('#u-extension').value = user.extension || '';
      $('#u-role').value = user.role;
      $('#u-active').checked = user.active;
    }
    $('#user-modal').hidden = false;
    $('#u-name').focus();
  }

  $('#new-user-btn').addEventListener('click', () => openUserModal());
  $('#users-body').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-user]');
    if (edit) return openUserModal(state.users.find((u) => u.id === edit.dataset.editUser));
    const del = e.target.closest('[data-del-user]');
    if (del) {
      const u = state.users.find((x) => x.id === del.dataset.delUser);
      if (!confirm(`Excluir o usuário ${u.name}?`)) return;
      try {
        await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`);
        toast('Usuário excluído');
        loadUsers();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('#u-name').value.trim(),
      username: $('#u-username').value.trim().toLowerCase(),
      extension: $('#u-extension').value.trim(),
      role: $('#u-role').value,
      active: $('#u-active').checked,
    };
    const pwd = $('#u-password').value;
    if (pwd) body.password = pwd;
    try {
      const editing = state.editingUser;
      const { user } = editing
        ? await api('PUT', `/api/users/${encodeURIComponent(editing.id)}`, body)
        : await api('POST', '/api/users', body);
      $('#user-modal').hidden = true;
      toast(editing ? 'Usuário atualizado' : 'Usuário criado');
      if (user.id === state.me.id) { state.me = user; showApp(); }
      loadUsers();
    } catch (err) {
      $('#user-error').textContent = err.message;
    }
  });

  // Fechar modais
  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => { m.hidden = true; });
  });

  // ---------- Histórico do ramal ----------
  const HIST_PAGE = 50;
  const DIR_LABEL = { in: 'Recebida', out: 'Realizada' };
  const HIST_STATUS = { answered: 'Atendida', missed: 'Perdida', noanswer: 'Não atendida', busy: 'Ocupado', failed: 'Falhou' };
  const hist = { direction: 'all', days: '7', search: '', records: [], offset: 0, loading: false, seq: 0 };

  const fmtDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
    if (!m) return esc(s);
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const isToday = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}` === `${m[1]}-${m[2]}-${m[3]}`;
    return `${isToday ? 'Hoje' : `${m[3]}/${m[2]}/${m[1]}`} ${m[4]}:${m[5]}`;
  };

  async function loadHistory(append = false) {
    const seq = ++hist.seq;
    if (!append) { hist.offset = 0; hist.records = []; }
    hist.loading = true;
    $('#h-more').disabled = true;
    if (!append) renderHistory('Carregando…');
    const qs = new URLSearchParams({
      days: hist.days, direction: hist.direction, search: hist.search, limit: HIST_PAGE, offset: hist.offset,
    });
    try {
      const res = await api('GET', `/api/history?${qs}`);
      if (seq !== hist.seq) return; // resposta de uma consulta antiga
      hist.records = hist.records.concat(res.records);
      hist.offset += HIST_PAGE;
      $('#h-more').hidden = !res.hasMore;
      if (res.summary) {
        $('#h-total').textContent = res.summary.total;
        $('#h-in').textContent = res.summary.in;
        $('#h-out').textContent = res.summary.out;
        $('#h-missed').textContent = res.summary.missed;
      }
      renderHistory();
    } catch (err) {
      if (seq !== hist.seq) return;
      $('#h-more').hidden = true;
      renderHistory(err.message);
    } finally {
      if (seq === hist.seq) { hist.loading = false; $('#h-more').disabled = false; }
    }
  }

  function renderHistory(message) {
    const extName = (x) => (state.pbx.extensions.find((e) => e.exten === x) || {}).name;
    const empty = $('#h-empty');
    if (message || !hist.records.length) {
      $('#h-body').innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `${icon('history')}<div>${esc(message || 'Nenhuma ligação encontrada no período')}</div>`;
      return;
    }
    empty.hidden = true;
    $('#h-body').innerHTML = hist.records.map((r) => {
      const kind = r.status === 'missed' ? 'missed' : r.direction;
      const name = r.peerName || extName(r.peer) || '';
      const canCall = r.peer && /^\+?[0-9*#]{2,32}$/.test(r.peer) && r.peer !== state.me.extension;
      return `<tr>
        <td><div class="dir ${kind}" title="${esc(DIR_LABEL[r.direction])}">${icon(kind)}</div></td>
        <td><div class="contact"><b class="num">${esc(name || r.peer || 'Desconhecido')}</b>${name ? `<span>${esc(r.peer)}</span>` : `<span>${esc(DIR_LABEL[r.direction])}</span>`}</div></td>
        <td class="num">${fmtDate(r.calldate)}</td>
        <td class="num">${r.status === 'answered' ? fmtDuration(r.billsec * 1000) : '—'}</td>
        <td><span class="badge st-${esc(r.status)}">${esc(HIST_STATUS[r.status] || r.status)}</span></td>
        <td style="text-align:right">${canCall ? `<button class="call-btn" type="button" data-call="${esc(r.peer)}" title="Ligar para ${esc(r.peer)}" aria-label="Ligar para ${esc(r.peer)}">${icon('phone')}</button>` : ''}</td>
      </tr>`;
    }).join('');
  }

  $('#h-direction').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-direction]');
    if (!chip) return;
    hist.direction = chip.dataset.direction;
    $$('#h-direction .chip').forEach((c) => c.classList.toggle('active', c === chip));
    loadHistory();
  });
  $('#h-days').addEventListener('change', (e) => { hist.days = e.target.value; loadHistory(); });
  let histSearchTimer;
  $('#h-search').addEventListener('input', (e) => {
    clearTimeout(histSearchTimer);
    histSearchTimer = setTimeout(() => { hist.search = e.target.value.trim(); loadHistory(); }, 350);
  });
  $('#h-more').addEventListener('click', () => !hist.loading && loadHistory(true));

  // ---------- Navegação ----------
  const VIEWS = { painel: 'Painel', historico: 'Histórico de ligações', usuarios: 'Usuários' };
  function route() {
    let view = (location.hash || '#painel').slice(1);
    if (view === 'usuarios' && state.me.role !== 'admin') view = 'painel';
    if (view === 'historico' && !state.me.extension) view = 'painel';
    if (!VIEWS[view]) view = 'painel';
    state.view = view;
    for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = v !== view;
    $('#view-title').textContent = VIEWS[view];
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $('.shell').classList.remove('nav-open');
    if (view === 'usuarios') loadUsers();
    if (view === 'historico') loadHistory();
  }
  window.addEventListener('hashchange', () => state.me && route());
  $('#menu-btn').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));

  // ---------- Tema ----------
  const savedTheme = (() => { try { return localStorage.getItem('sb-theme'); } catch { return null; } })();
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sb-theme', next); } catch { /* ignora */ }
  });

  // ---------- Início ----------
  api('GET', '/api/me')
    .then(({ user }) => { state.me = user; showApp(); })
    .catch(() => showLogin());
})();

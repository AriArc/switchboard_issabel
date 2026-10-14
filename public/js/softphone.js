'use strict';

/**
 * Telefone no navegador (WebRTC) — opcional.
 *
 * Usado quando o cliente não tem telefone IP nem softphone: o switchboard registra o ramal do usuário
 * no Asterisk via JsSIP (SIP sobre WebSocket, repassado pelo servidor em /sip) e toca/atende as
 * ligações aqui mesmo. Carregado só quando WEBRTC_ENABLED=1 e o usuário tem a opção marcada.
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  let ua = null;
  let cfg = null;
  let session = null;
  let starting = false;
  let callStart = 0;
  let timer = null;
  let ringer = null;
  let titleBlink = null;
  const originalTitle = document.title;

  const SB = () => window.SB;
  const domain = () => (cfg && cfg.domain) || location.hostname;

  // ---------- Interface ----------
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.hidden = true;

  const dock = document.createElement('div');
  dock.className = 'sp-dock';
  dock.hidden = true;
  dock.setAttribute('role', 'dialog');
  dock.setAttribute('aria-live', 'assertive');
  dock.innerHTML = `
    <div class="sp-head"><span class="sp-state"></span><span class="sp-timer"></span></div>
    <div class="sp-peer"><b></b><small></small></div>
    <div class="sp-keypad" hidden></div>
    <div class="sp-actions"></div>`;

  document.addEventListener('DOMContentLoaded', () => {
    // Antes da área de avisos, para que eles subam quando o painel do telefone estiver aberto
    document.body.insertBefore(dock, document.getElementById('toasts'));
    document.body.append(audio);
    $('.sp-keypad', dock).innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']
      .map((k) => `<button type="button" data-dtmf="${k}">${k}</button>`).join('');
  });

  function setStatus(kind, text) {
    const pill = $('#sp-status');
    if (!pill) return;
    pill.hidden = !kind;
    pill.className = `sp-pill ${kind || ''}`;
    $('.txt', pill).textContent = text || '';
    pill.title = text || '';
  }

  const btn = (action, label, iconId, cls = '') =>
    `<button type="button" class="sp-btn ${cls}" data-sp="${action}" title="${label}" aria-label="${label}">${SB().icon(iconId)}<span>${label}</span></button>`;

  function render(state) {
    if (!session) { dock.hidden = true; return; }
    const r = session.remote_identity;
    const number = (r && r.uri && r.uri.user) || '';
    const ext = SB().state.pbx.extensions.find((e) => e.exten === number);
    const name = (ext && ext.name && ext.name !== ext.exten && ext.name) || (r && r.display_name !== number && r.display_name) || '';
    $('.sp-peer b', dock).textContent = name || number || 'Desconhecido';
    $('.sp-peer small', dock).textContent = name ? number : '';
    const labels = { incoming: 'Recebendo ligação', outgoing: 'Chamando…', active: 'Em ligação', held: 'Em espera' };
    $('.sp-state', dock).textContent = labels[state] || '';
    dock.className = `sp-dock ${state}`;
    let actions = '';
    if (state === 'incoming') actions = btn('answer', 'Atender', 'phone', 'ok') + btn('reject', 'Recusar', 'phone-off', 'danger');
    else if (state === 'outgoing') actions = btn('hangup', 'Cancelar', 'phone-off', 'danger');
    else {
      actions = btn('mute', session.isMuted().audio ? 'Ativar mic' : 'Mudo', session.isMuted().audio ? 'mic' : 'mic-off', session.isMuted().audio ? 'on' : '')
        + btn('hold', state === 'held' ? 'Retomar' : 'Espera', state === 'held' ? 'phone' : 'pause', state === 'held' ? 'on' : '')
        + btn('keypad', 'Teclado', 'dialpad', $('.sp-keypad', dock).hidden ? '' : 'on')
        + btn('hangup', 'Desligar', 'phone-off', 'danger');
    }
    $('.sp-actions', dock).innerHTML = actions;
    if (state !== 'active' && state !== 'held') $('.sp-keypad', dock).hidden = true;
    dock.hidden = false;
  }

  function startTimer() {
    callStart = Date.now();
    clearInterval(timer);
    const tick = () => { $('.sp-timer', dock).textContent = SB().fmtDuration(Date.now() - callStart); };
    tick();
    timer = setInterval(tick, 1000);
  }

  // Toque de chamada (425 Hz, 1 s ligado / 4 s desligado) gerado pelo navegador
  function startRing(caller) {
    stopRing();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const ring = () => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 425;
        gain.gain.value = 0.15;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 1);
      };
      ring();
      ringer = { ctx, interval: setInterval(ring, 5000) };
    } catch { /* sem áudio: o aviso visual continua */ }
    let on = false;
    titleBlink = setInterval(() => { on = !on; document.title = on ? `📞 ${caller}` : originalTitle; }, 1000);
  }

  function stopRing() {
    if (ringer) { clearInterval(ringer.interval); ringer.ctx.close().catch(() => {}); ringer = null; }
    clearInterval(titleBlink);
    titleBlink = null;
    document.title = originalTitle;
  }

  // ---------- SIP ----------
  function mediaOptions() {
    return {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: (cfg.stun || []).map((urls) => ({ urls })) },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    };
  }

  const FAIL_TEXT = {
    Busy: 'Ocupado', Rejected: 'Ligação recusada', Unavailable: 'Indisponível', 'Not Found': 'Número não encontrado',
    'No Answer': 'Não atendida', 'User Denied Media Access': 'Permita o uso do microfone no navegador',
    'Address Incomplete': 'Número incompleto', 'Connection Error': 'Falha de conexão com o PABX',
  };

  // Toca o áudio do outro lado da ligação
  function attachMedia(pc) {
    const play = (stream) => {
      if (audio.srcObject === stream) return;
      audio.srcObject = stream;
      audio.play().catch(() => {});
    };
    pc.addEventListener('track', (ev) => play(ev.streams[0] || new MediaStream([ev.track])));
    const tracks = pc.getReceivers().map((r) => r.track).filter((t) => t && t.kind === 'audio');
    if (tracks.length) play(new MediaStream(tracks));
  }

  function onSession(s, originator) {
    if (session) {
      // Já há uma ligação no navegador: novas chamadas recebem "ocupado"
      if (originator === 'remote') s.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
      return;
    }
    session = s;
    // Nas ligações feitas pelo navegador a conexão de mídia já existe quando a sessão é anunciada
    if (s.connection) attachMedia(s.connection);
    s.on('peerconnection', (e) => attachMedia(e.peerconnection));
    s.on('accepted', () => { stopRing(); startTimer(); render('active'); });
    s.on('hold', () => render('held'));
    s.on('unhold', () => render('active'));
    s.on('muted', () => render(s.isOnHold().local ? 'held' : 'active'));
    s.on('unmuted', () => render(s.isOnHold().local ? 'held' : 'active'));
    const end = (e) => {
      stopRing();
      clearInterval(timer);
      $('.sp-timer', dock).textContent = '';
      audio.srcObject = null;
      // Avisa o motivo da falha (inclusive falhas locais, como microfone bloqueado)
      const mic = e && e.cause === 'User Denied Media Access';
      if (e && e.cause && FAIL_TEXT[e.cause] && (mic || e.originator !== 'local') && !(originator === 'remote' && e.cause === 'Canceled')) {
        SB().toast(FAIL_TEXT[e.cause], 'err');
      }
      session = null;
      render();
    };
    s.on('ended', end);
    s.on('failed', end);

    if (originator === 'remote') {
      const r = s.remote_identity;
      startRing((r && (r.display_name || r.uri.user)) || 'Ligação');
      render('incoming');
    } else {
      render('outgoing');
    }
  }

  async function loadJsSIP() {
    if (window.JsSIP) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jssip.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Não foi possível carregar o telefone do navegador (JsSIP)'));
      document.head.appendChild(s);
    });
  }

  async function start() {
    if (ua || starting) return;
    starting = true;
    try {
      cfg = await SB().api('GET', '/api/webrtc');
      if (!cfg.enabled) return setStatus(null);
      if (!window.isSecureContext || !cfg.secure) return setStatus('off', 'Telefone: requer HTTPS');
      if (!cfg.password) return setStatus('off', 'Telefone: senha SIP não cadastrada');
      await loadJsSIP();
      setStatus('wait', 'Telefone: conectando…');
      ua = new window.JsSIP.UA({
        sockets: [new window.JsSIP.WebSocketInterface(`wss://${location.host}/sip`)],
        uri: `sip:${cfg.extension}@${domain()}`,
        password: cfg.password,
        display_name: cfg.displayName,
        register: true,
        session_timers: false,
        user_agent: 'Switchboard Intek WebRTC',
      });
      ua.on('connecting', () => setStatus('wait', 'Telefone: conectando…'));
      ua.on('registered', () => setStatus('on', `Telefone: ramal ${cfg.extension}`));
      ua.on('unregistered', () => setStatus('off', 'Telefone: não registrado'));
      ua.on('disconnected', () => setStatus('off', 'Telefone: desconectado'));
      ua.on('registrationFailed', (e) => {
        setStatus('off', e.cause === 'Authentication Error' ? 'Telefone: senha SIP incorreta' : 'Telefone: falha no registro');
      });
      ua.on('newRTCSession', ({ session: s, originator }) => onSession(s, originator));
      ua.start();
    } catch (err) {
      setStatus('off', 'Telefone: erro');
      SB().toast(err.message, 'err');
    } finally {
      starting = false;
    }
  }

  function stop() {
    stopRing();
    clearInterval(timer);
    if (session) { try { session.terminate(); } catch { /* já encerrada */ } }
    session = null;
    if (ua) { try { ua.stop(); } catch { /* ignora */ } }
    ua = null;
    cfg = null;
    dock.hidden = true;
    setStatus(null);
  }

  function ready() {
    return Boolean(ua && ua.isRegistered());
  }

  function call(number) {
    if (!ready()) return false;
    if (session) {
      SB().toast('Já existe uma ligação no telefone do navegador', 'err');
      return true;
    }
    try {
      ua.call(`sip:${number}@${domain()}`, mediaOptions());
    } catch (err) {
      SB().toast(err.message, 'err');
    }
    return true;
  }

  // ---------- Ações dos botões ----------
  dock.addEventListener('click', (e) => {
    const dtmf = e.target.closest('[data-dtmf]');
    if (dtmf && session) {
      session.sendDTMF(dtmf.dataset.dtmf, { transportType: 'RFC2833' });
      return;
    }
    const b = e.target.closest('[data-sp]');
    if (!b || !session) return;
    const action = b.dataset.sp;
    if (action === 'answer') { stopRing(); session.answer(mediaOptions()); }
    if (action === 'reject') session.terminate({ status_code: 603, reason_phrase: 'Decline' });
    if (action === 'hangup') session.terminate();
    if (action === 'mute') {
      if (session.isMuted().audio) session.unmute({ audio: true });
      else session.mute({ audio: true });
    }
    if (action === 'hold') {
      if (session.isOnHold().local) session.unhold();
      else session.hold();
    }
    if (action === 'keypad') {
      const pad = $('.sp-keypad', dock);
      pad.hidden = !pad.hidden;
      render(session.isOnHold().local ? 'held' : 'active');
    }
  });

  // Teclado do computador envia DTMF durante a ligação (ex.: menus de atendimento)
  document.addEventListener('keydown', (e) => {
    if (!session || !session.isEstablished() || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (/^[0-9*#]$/.test(e.key)) session.sendDTMF(e.key, { transportType: 'RFC2833' });
  });

  window.addEventListener('beforeunload', (e) => {
    if (session) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { if (ua) ua.stop(); });

  window.Softphone = { start, stop, ready, call };
})();

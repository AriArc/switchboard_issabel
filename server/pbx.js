'use strict';

const { EventEmitter } = require('events');
const { AmiClient } = require('./ami');

// Códigos de estado de extensão do Asterisk (ExtensionStatus / ExtensionStateList)
const EXT_STATUS = {
  '-2': 'unavailable', // removida
  '-1': 'unavailable', // não encontrada
  0: 'idle',
  1: 'inuse',
  2: 'busy',
  4: 'unavailable',
  8: 'ringing',
  9: 'ringing', // em uso + tocando
  16: 'onhold',
  17: 'onhold', // em uso + espera
};

const CHANNEL_STATE = {
  0: 'down', 1: 'down', 2: 'down', 3: 'dialing', 4: 'ringing', 5: 'ringing', 6: 'up', 7: 'busy',
};

// "SIP/1001-0000001a" -> "1001" ; "PJSIP/1001-00000002" -> "1001"
function channelExtension(channel) {
  const m = /^(?:SIP|PJSIP|IAX2|DAHDI)\/([^-@;]+)/i.exec(channel || '');
  return m ? m[1] : null;
}

function isRealChannel(channel) {
  return /^(?:SIP|PJSIP|IAX2|DAHDI|Console)\//i.test(channel || '');
}

function cleanNum(v) {
  return v && v !== '<unknown>' && v !== 'unknown' ? v : '';
}

/**
 * Estado do PABX (ramais + chamadas ativas), independente da origem dos dados.
 * Emite 'change' (com debounce) sempre que algo muda.
 */
class PbxState extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.extensions = new Map(); // exten -> { exten, name, status }
    this.channels = new Map();   // uniqueid -> channel info
    this._timer = null;
  }

  changed() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('change');
    }, 150);
  }

  setExtension(exten, fields) {
    const cur = this.extensions.get(exten) || { exten, name: '', status: 'unavailable' };
    this.extensions.set(exten, { ...cur, ...fields });
    this.changed();
  }

  upsertChannel(uniqueid, fields) {
    if (!uniqueid) return;
    const cur = this.channels.get(uniqueid) || { uniqueid, startedAt: Date.now() };
    const next = { ...cur };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
    this.channels.set(uniqueid, next);
    this.changed();
  }

  removeChannel(uniqueid) {
    if (this.channels.delete(uniqueid)) this.changed();
  }

  findChannelByName(name) {
    for (const c of this.channels.values()) if (c.channel === name) return c;
    return null;
  }

  /** Agrupa canais por linkedid, formando as chamadas exibidas no painel. */
  calls() {
    const groups = new Map();
    for (const c of this.channels.values()) {
      if (!isRealChannel(c.channel)) continue;
      const key = c.linkedid || c.uniqueid;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const calls = [];
    for (const [id, chans] of groups) {
      chans.sort((a, b) => a.startedAt - b.startedAt);
      const origin = chans.find((c) => c.uniqueid === id) || chans[0];
      const other = chans.find((c) => c !== origin);
      const extOf = (c) => {
        const ext = c && channelExtension(c.channel);
        return ext && this.extensions.has(ext) ? ext : null;
      };
      const from = extOf(origin) || cleanNum(origin.calleridnum) || '';
      const to =
        extOf(other) ||
        cleanNum(origin.connectedlinenum) ||
        (origin.exten && origin.exten !== 's' ? origin.exten : '') ||
        (other && cleanNum(other.calleridnum)) ||
        '';
      const anyUp = chans.some((c) => c.state === 'up');
      calls.push({
        id,
        from,
        fromName: this._displayName(from, origin.calleridname),
        to,
        toName: this._displayName(to, other ? other.calleridname : origin.connectedlinename),
        state: anyUp ? 'up' : 'ringing',
        startedAt: origin.startedAt,
        answeredAt: chans.reduce((t, c) => (c.answeredAt && (!t || c.answeredAt < t) ? c.answeredAt : t), null),
        extensions: [...new Set(chans.map(extOf).filter(Boolean))],
        channels: chans.map((c) => ({ channel: c.channel, extension: extOf(c), state: c.state })),
      });
    }
    return calls.sort((a, b) => a.startedAt - b.startedAt);
  }

  _displayName(num, fallback) {
    const ext = this.extensions.get(num);
    if (ext && ext.name) return ext.name;
    const name = cleanNum(fallback);
    return name && name !== num ? name : '';
  }

  snapshot() {
    const calls = this.calls();
    const peerByExt = {};
    for (const call of calls) {
      for (const ext of call.extensions) {
        const peer = call.extensions.find((e) => e !== ext) || (call.from === ext ? call.to : call.from);
        peerByExt[ext] = { callId: call.id, peer, since: call.answeredAt || call.startedAt };
      }
    }
    const extensions = [...this.extensions.values()]
      .map((e) => ({ ...e, call: peerByExt[e.exten] || null }))
      .sort((a, b) => a.exten.localeCompare(b.exten, 'pt-BR', { numeric: true }));
    return { connected: this.connected, extensions, calls, serverTime: Date.now() };
  }
}

/** Implementação real: conecta ao AMI do Issabel. */
class AmiPbx extends PbxState {
  constructor(config) {
    super();
    this.config = config;
    this.ami = new AmiClient(config.ami);
    this.ami.on('connected', () => this._onConnected());
    this.ami.on('disconnected', () => {
      this.connected = false;
      this.channels.clear();
      this.changed();
      console.warn('[ami] desconectado — tentando reconectar');
    });
    this.ami.on('error', (err) => console.error('[ami]', err.message));
    this.ami.on('event', (evt) => this._onEvent(evt));
  }

  start() {
    this.ami.start();
    this._refreshTimer = setInterval(() => this.connected && this.loadExtensions().catch(() => {}), 60000);
  }

  async _onConnected() {
    console.log(`[ami] conectado em ${this.config.ami.host}:${this.config.ami.port}`);
    this.connected = true;
    try {
      await this.loadExtensions();
      await this.loadChannels();
    } catch (err) {
      console.error('[ami] erro ao carregar estado inicial:', err.message);
    }
    this.changed();
  }

  async loadExtensions() {
    const names = await this._loadNames();
    const res = await this.ami.action({ Action: 'ExtensionStateList' }, { timeout: 20000 });
    const seen = new Set();
    for (const e of res.events || []) {
      if (e.context !== this.config.hintContext || !/^\d+$/.test(e.exten)) continue;
      seen.add(e.exten);
      this.setExtension(e.exten, { name: names[e.exten] || '', status: EXT_STATUS[e.status] || 'unavailable' });
    }
    // Ramais cadastrados no Issabel sem hint também aparecem
    for (const [exten, name] of Object.entries(names)) {
      if (!seen.has(exten)) this.setExtension(exten, { name });
    }
  }

  // Nomes dos ramais a partir do AstDB do FreePBX/Issabel: /AMPUSER/<ramal>/cidname
  async _loadNames() {
    const names = {};
    try {
      const res = await this.ami.action({ Action: 'Command', Command: 'database show AMPUSER' });
      for (const line of res.output || []) {
        const m = /^\/AMPUSER\/(\d+)\/cidname\s*:\s*(.*?)\s*$/.exec(line);
        if (m) names[m[1]] = m[2];
      }
    } catch (err) {
      console.warn('[ami] não foi possível ler nomes dos ramais:', err.message);
    }
    return names;
  }

  async loadChannels() {
    const res = await this.ami.action({ Action: 'CoreShowChannels' }, { timeout: 20000 });
    this.channels.clear();
    const now = Date.now();
    for (const c of res.events || []) {
      const seconds = parseDuration(c.duration);
      const state = CHANNEL_STATE[c.channelstate] || 'down';
      this.upsertChannel(c.uniqueid, {
        channel: c.channel,
        linkedid: c.linkedid || c.uniqueid,
        calleridnum: c.calleridnum,
        calleridname: c.calleridname,
        connectedlinenum: c.connectedlinenum,
        connectedlinename: c.connectedlinename,
        exten: c.exten,
        state,
        startedAt: now - seconds * 1000,
        answeredAt: state === 'up' ? now - seconds * 1000 : null,
      });
    }
  }

  _onEvent(e) {
    switch (e.event) {
      case 'ExtensionStatus':
        if (e.context === this.config.hintContext && /^\d+$/.test(e.exten)) {
          this.setExtension(e.exten, { status: EXT_STATUS[e.status] || 'unavailable' });
        }
        break;
      case 'Newchannel':
        this.upsertChannel(e.uniqueid, {
          channel: e.channel,
          linkedid: e.linkedid || e.uniqueid,
          calleridnum: e.calleridnum,
          calleridname: e.calleridname,
          connectedlinenum: e.connectedlinenum,
          connectedlinename: e.connectedlinename,
          exten: e.exten,
          state: CHANNEL_STATE[e.channelstate] || 'down',
          startedAt: Date.now(),
        });
        break;
      case 'Newstate': {
        const state = CHANNEL_STATE[e.channelstate] || 'down';
        const cur = this.channels.get(e.uniqueid);
        this.upsertChannel(e.uniqueid, {
          channel: e.channel,
          state,
          calleridnum: e.calleridnum,
          calleridname: e.calleridname,
          connectedlinenum: e.connectedlinenum,
          connectedlinename: e.connectedlinename,
          answeredAt: state === 'up' && !(cur && cur.answeredAt) ? Date.now() : undefined,
        });
        break;
      }
      case 'NewCallerid':
      case 'NewConnectedLine':
        if (this.channels.has(e.uniqueid)) {
          this.upsertChannel(e.uniqueid, {
            calleridnum: e.calleridnum,
            calleridname: e.calleridname,
            connectedlinenum: e.connectedlinenum,
            connectedlinename: e.connectedlinename,
          });
        }
        break;
      case 'NewExten':
        if (this.channels.has(e.uniqueid) && e.context === this.config.dialContext) {
          this.upsertChannel(e.uniqueid, { exten: e.exten });
        }
        break;
      case 'Rename':
        if (this.channels.has(e.uniqueid)) this.upsertChannel(e.uniqueid, { channel: e.newname });
        break;
      case 'Hangup':
        this.removeChannel(e.uniqueid);
        break;
      default:
    }
  }

  /**
   * Click-to-call: toca primeiro o ramal do usuário e, ao atender, disca o destino
   * pelo contexto de discagem (from-internal), respeitando rotas de saída do Issabel.
   */
  async originate(extension, number) {
    const res = await this.ami.action(
      {
        Action: 'Originate',
        Channel: `${this.config.channelTech}/${extension}`,
        Context: this.config.dialContext,
        Exten: number,
        Priority: 1,
        // Número = ramal (as rotas de saída identificam o usuário); nome = destino (aparece no visor)
        CallerID: `"Chamando ${number}" <${extension}>`,
        Timeout: this.config.originateTimeoutMs,
        Async: 'true',
        Variable: [`SB_CLICK2CALL=1`, `SB_DEST=${number}`],
      },
      { timeout: 15000 }
    );
    if (res.response !== 'Success') throw new Error(res.message || 'Falha ao originar chamada');
  }

  async hangup(channel) {
    const res = await this.ami.action({ Action: 'Hangup', Channel: channel });
    if (res.response !== 'Success') throw new Error(res.message || 'Falha ao desligar');
  }

  async redirect(channel, target) {
    const res = await this.ami.action({
      Action: 'Redirect',
      Channel: channel,
      Context: this.config.dialContext,
      Exten: target,
      Priority: 1,
    });
    if (res.response !== 'Success') throw new Error(res.message || 'Falha ao transferir');
  }
}

function parseDuration(d) {
  if (!d) return 0;
  if (/^\d+$/.test(d)) return Number(d);
  return d.split(':').reduce((acc, p) => acc * 60 + Number(p || 0), 0);
}

module.exports = { PbxState, AmiPbx, channelExtension, EXT_STATUS, parseDuration };

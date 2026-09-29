'use strict';

const { PbxState } = require('./pbx');

const NAMES = [
  'Recepção', 'Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Eduarda Alves',
  'Felipe Costa', 'Gabriela Nunes', 'Henrique Dias', 'Isabela Freitas', 'João Pereira',
  'Karina Martins', 'Lucas Barros', 'Mariana Teixeira', 'Suporte', 'Financeiro',
];

/**
 * PABX simulado para demonstração e testes (MOCK_PBX=1).
 * Gera chamadas aleatórias e responde ao click-to-call como o Issabel faria.
 */
class MockPbx extends PbxState {
  constructor(config) {
    super();
    this.config = config;
    this.seq = 0;
  }

  start() {
    this.connected = true;
    NAMES.forEach((name, i) => this.setExtension(String(1000 + i), { name, status: i === 13 ? 'unavailable' : 'idle' }));
    this._tick = setInterval(() => this._randomActivity(), 4000);
    this._randomActivity();
    this._randomActivity();
  }

  _id() {
    return `mock.${Date.now()}.${++this.seq}`;
  }

  _freeExtensions() {
    return [...this.extensions.values()].filter((e) => e.status === 'idle').map((e) => e.exten);
  }

  _addChannel(linkedid, tech, name, callerid, state) {
    const uniqueid = linkedid && !this.channels.has(linkedid) ? linkedid : this._id();
    this.upsertChannel(uniqueid, {
      channel: `${tech}/${name}-${(++this.seq).toString(16).padStart(8, '0')}`,
      linkedid: linkedid || uniqueid,
      calleridnum: callerid,
      state,
      answeredAt: state === 'up' ? Date.now() : null,
    });
    return uniqueid;
  }

  _setCallState(linkedid, state) {
    for (const c of this.channels.values()) {
      if (c.linkedid !== linkedid) continue;
      this.upsertChannel(c.uniqueid, { state, answeredAt: state === 'up' ? Date.now() : c.answeredAt });
      const ext = c.channel.match(/^SIP\/(\d+)-/);
      if (ext) this.setExtension(ext[1], { status: state === 'up' ? 'inuse' : 'ringing' });
    }
  }

  _endCall(linkedid) {
    for (const c of [...this.channels.values()]) {
      if (c.linkedid !== linkedid) continue;
      const ext = c.channel.match(/^SIP\/(\d+)-/);
      if (ext && this.extensions.get(ext[1]).status !== 'unavailable') this.setExtension(ext[1], { status: 'idle' });
      this.removeChannel(c.uniqueid);
    }
  }

  _randomActivity() {
    const active = new Set([...this.channels.values()].map((c) => c.linkedid));
    if (active.size >= 5) {
      this._endCall([...active][Math.floor(Math.random() * active.size)]);
      return;
    }
    const free = this._freeExtensions();
    if (free.length < 2) return;
    const a = free[Math.floor(Math.random() * free.length)];
    const incoming = Math.random() < 0.6;
    const linkedid = this._id();
    if (incoming) {
      const number = `119${Math.floor(10000000 + Math.random() * 89999999)}`;
      this._addChannel(linkedid, 'SIP', 'tronco-operadora', number, 'ringing');
      this._addChannel(linkedid, 'SIP', a, a, 'ringing');
      this.setExtension(a, { status: 'ringing' });
    } else {
      const b = free.filter((x) => x !== a)[0];
      this._addChannel(linkedid, 'SIP', a, a, 'ringing');
      this._addChannel(linkedid, 'SIP', b, b, 'ringing');
      this.setExtension(a, { status: 'inuse' });
      this.setExtension(b, { status: 'ringing' });
    }
    setTimeout(() => this.channels.has(linkedid) && this._setCallState(linkedid, 'up'), 3000);
    setTimeout(() => this._endCall(linkedid), 15000 + Math.random() * 45000);
  }

  async originate(extension, number) {
    const ext = this.extensions.get(extension);
    if (!ext || ext.status === 'unavailable') throw new Error(`Ramal ${extension} indisponível`);
    const linkedid = this._id();
    const origin = this._addChannel(linkedid, 'SIP', extension, extension, 'ringing');
    this.upsertChannel(origin, { calleridname: `Chamando ${number}`, exten: number });
    this.setExtension(extension, { status: 'ringing' });
    setTimeout(() => {
      if (!this.channels.has(origin)) return;
      this.upsertChannel(origin, { state: 'up', answeredAt: Date.now() });
      this.setExtension(extension, { status: 'inuse' });
      const target = this.extensions.get(number);
      if (target) {
        this._addChannel(linkedid, 'SIP', number, number, 'ringing');
        this.setExtension(number, { status: 'ringing' });
      } else {
        this._addChannel(linkedid, 'SIP', 'tronco-operadora', number, 'ringing');
      }
      setTimeout(() => this.channels.has(origin) && this._setCallState(linkedid, 'up'), 2500);
    }, 2000);
    setTimeout(() => this._endCall(linkedid), 40000);
  }

  async hangup(channel) {
    const c = this.findChannelByName(channel);
    if (!c) throw new Error('Canal não encontrado');
    this._endCall(c.linkedid);
  }

  async redirect(channel, target) {
    const c = this.findChannelByName(channel);
    if (!c) throw new Error('Canal não encontrado');
    for (const other of [...this.channels.values()]) {
      if (other.linkedid === c.linkedid && other.uniqueid !== c.uniqueid) {
        const ext = other.channel.match(/^SIP\/(\d+)-/);
        if (ext) this.setExtension(ext[1], { status: 'idle' });
        this.removeChannel(other.uniqueid);
      }
    }
    const isExt = this.extensions.has(target);
    this._addChannel(c.linkedid, 'SIP', isExt ? target : 'tronco-operadora', target, 'ringing');
    if (isExt) this.setExtension(target, { status: 'ringing' });
    setTimeout(() => this.channels.has(c.uniqueid) && this._setCallState(c.linkedid, 'up'), 2500);
  }
}

module.exports = { MockPbx };

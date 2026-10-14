'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = ['admin', 'supervisor', 'operator', 'user'];
// Perfis que veem histórico e gravações de todos os ramais
const SUPERVISOR_ROLES = ['admin', 'supervisor'];
const EXTENSION_RE = /^\d{2,8}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Senha SIP do ramal (WebRTC) guardada criptografada com AES-256-GCM, chave derivada do SESSION_SECRET
function sipKey(secret) {
  return crypto.scryptSync(String(secret || 'switchboard'), 'switchboard-sip-password', 32);
}

function encryptSecret(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sipKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `gcm$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${data.toString('base64')}`;
}

function decryptSecret(stored, secret) {
  try {
    const [algo, iv, tag, data] = String(stored || '').split('$');
    if (algo !== 'gcm') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', sipKey(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // SESSION_SECRET trocado ou dado corrompido: senha precisa ser cadastrada de novo
  }
}

/** Cadastro de usuários em arquivo JSON. Cada usuário tem um ramal discador associado. */
class UserStore {
  constructor(file, { secret } = {}) {
    this.secret = secret;
    this.file = file;
    this.users = [];
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  ensureAdmin({ username, password }) {
    if (this.users.length) return null;
    return this.create({ name: 'Administrador', username, password, extension: '', role: 'admin' });
  }

  list() {
    return this.users.map(publicUser);
  }

  get(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  authenticate(username, password) {
    const u = this.users.find((x) => x.username === String(username || '').toLowerCase());
    if (!u || !u.active || !verifyPassword(String(password || ''), u.passwordHash)) return null;
    return u;
  }

  validate(data, { partial = false, id = null } = {}) {
    const errors = [];
    const has = (k) => data[k] !== undefined;

    if (!partial || has('name')) {
      if (!String(data.name || '').trim()) errors.push('Nome é obrigatório');
    }
    if (!partial || has('username')) {
      const username = String(data.username || '').toLowerCase();
      if (!USERNAME_RE.test(username)) errors.push('Usuário deve ter 3–32 caracteres (letras, números, . _ -)');
      else if (this.users.some((u) => u.username === username && u.id !== id)) errors.push('Usuário já existe');
    }
    if (!partial || has('password')) {
      if (!partial || data.password) {
        if (String(data.password || '').length < 6) errors.push('Senha deve ter pelo menos 6 caracteres');
      }
    }
    if (!partial || has('role')) {
      if (!ROLES.includes(data.role)) errors.push('Perfil inválido');
      else if (partial && !has('extension') && data.role !== 'admin' && !(this.get(id) || {}).extension) {
        errors.push('Ramal discador é obrigatório');
      }
    }
    if (!partial || has('extension')) {
      const ext = String(data.extension || '');
      const role = data.role || (id && this.get(id) && this.get(id).role);
      if (ext && !EXTENSION_RE.test(ext)) errors.push('Ramal inválido');
      else if (!ext && role !== 'admin') errors.push('Ramal discador é obrigatório');
      else if (ext && this.users.some((u) => u.extension === ext && u.id !== id)) {
        errors.push(`Ramal ${ext} já está associado a outro usuário`);
      }
    }
    // WebRTC (telefone no navegador) precisa de ramal; a senha SIP pode ser cadastrada depois
    const cur = (id && this.get(id)) || {};
    const webrtc = has('webrtc') ? Boolean(data.webrtc) : Boolean(cur.webrtc);
    const ext = has('extension') ? String(data.extension || '') : cur.extension;
    if (webrtc && !ext) errors.push('Telefone no navegador (WebRTC) exige um ramal discador');
    if (has('sipPassword') && data.sipPassword && String(data.sipPassword).length > 128) errors.push('Senha SIP muito longa');
    return errors;
  }

  create(data) {
    const errors = this.validate(data);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors });
    const user = {
      id: crypto.randomUUID(),
      name: String(data.name).trim(),
      username: String(data.username).toLowerCase(),
      passwordHash: hashPassword(String(data.password)),
      extension: String(data.extension || ''),
      role: data.role,
      active: data.active !== false,
      webrtc: Boolean(data.webrtc),
      sipPasswordEnc: data.sipPassword ? encryptSecret(data.sipPassword, this.secret) : null,
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this.save();
    return publicUser(user);
  }

  update(id, data) {
    const user = this.get(id);
    if (!user) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const errors = this.validate(data, { partial: true, id });
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors });
    if (data.name !== undefined) user.name = String(data.name).trim();
    if (data.username !== undefined) user.username = String(data.username).toLowerCase();
    if (data.password) user.passwordHash = hashPassword(String(data.password));
    if (data.extension !== undefined) user.extension = String(data.extension);
    if (data.role !== undefined) user.role = data.role;
    if (data.active !== undefined) user.active = Boolean(data.active);
    if (data.webrtc !== undefined) user.webrtc = Boolean(data.webrtc);
    // Senha SIP: só troca quando informada (campo vazio mantém a atual)
    if (data.sipPassword) user.sipPasswordEnc = encryptSecret(data.sipPassword, this.secret);
    this._assertAdminRemains();
    this.save();
    return publicUser(user);
  }

  /** Senha SIP do ramal (para o telefone no navegador), ou null. */
  sipPassword(id) {
    const user = this.get(id);
    return user && user.sipPasswordEnc ? decryptSecret(user.sipPasswordEnc, this.secret) : null;
  }

  setSession(id, sessionId) {
    const user = this.get(id);
    if (!user) return;
    user.sessionId = sessionId || null;
    this.save();
  }

  remove(id) {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const [removed] = this.users.splice(idx, 1);
    try {
      this._assertAdminRemains();
    } catch (err) {
      this.users.splice(idx, 0, removed);
      throw err;
    }
    this.save();
  }

  _assertAdminRemains() {
    if (!this.users.some((u) => u.role === 'admin' && u.active)) {
      this.load();
      throw Object.assign(new Error('É necessário manter ao menos um administrador ativo'), { status: 400 });
    }
  }
}

function publicUser(u) {
  const { passwordHash, sessionId, sipPasswordEnc, ...rest } = u;
  return { ...rest, webrtc: Boolean(u.webrtc), hasSipPassword: Boolean(sipPasswordEnc) };
}

module.exports = { UserStore, ROLES, SUPERVISOR_ROLES, hashPassword, verifyPassword, publicUser };

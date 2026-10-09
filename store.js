// Magazyn historii czatu. Wiadomości i pliki starsze niż `retentionMs` są automatycznie usuwane.
//
//  - FileStore  (domyślny): metadane w pamięci + zrzut JSON, bajty plików jako osobne pliki na dysku.
//                           Na darmowym Renderze dysk jest tymczasowy – dane znikają przy restarcie/uśpieniu.
//  - MongoStore (gdy ustawiono MONGODB_URI): trwała historia w MongoDB (np. darmowy Atlas),
//                           usuwanie po czasie realizuje indeks TTL.

const fs = require('fs/promises');
const path = require('path');

class FileStore {
  constructor({ dir, retentionMs, maxBytes }) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.metaPath = path.join(dir, 'messages.json');
    this.retentionMs = retentionMs;
    this.maxBytes = maxBytes;
    this.accountsPath = path.join(dir, 'accounts.json');
    this.messages = [];
    this.accounts = new Map(); // id -> konto
    this.saveTimer = null;
  }

  get label() {
    return `pliki w ${this.dir}`;
  }

  async init() {
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      this.messages = JSON.parse(await fs.readFile(this.metaPath, 'utf8'));
    } catch {
      this.messages = [];
    }
    try {
      const list = JSON.parse(await fs.readFile(this.accountsPath, 'utf8'));
      this.accounts = new Map(list.map((a) => [a.id, a]));
    } catch {
      this.accounts = new Map();
    }
    await this.prune();

    // Usuń osierocone pliki (np. po awarii w trakcie zapisu).
    const known = new Set(this.messages.filter((m) => m.kind === 'file').map((m) => m.id));
    for (const name of await fs.readdir(this.filesDir)) {
      if (!known.has(name)) await fs.unlink(path.join(this.filesDir, name)).catch(() => {});
    }
  }

  async loadAccounts() {
    return Array.from(this.accounts.values());
  }

  async saveAccount(account) {
    this.accounts.set(account.id, { ...account });
    this.scheduleSave();
  }

  async add(msg) {
    const { data, ...meta } = msg;
    if (msg.kind === 'file') await fs.writeFile(path.join(this.filesDir, msg.id), data);
    this.messages.push(meta);
    this.scheduleSave();
    if (msg.kind === 'file') await this.prune(); // pilnuje też limitu miejsca
  }

  async recent(since, limit) {
    return this.messages.filter((m) => m.time >= since).slice(-limit);
  }

  async fileData(id) {
    const cutoff = Date.now() - this.retentionMs;
    const meta = this.messages.find((m) => m.kind === 'file' && m.id === id && m.time >= cutoff);
    if (!meta) return null;
    try {
      return await fs.readFile(path.join(this.filesDir, meta.id));
    } catch {
      return null;
    }
  }

  async prune() {
    const cutoff = Date.now() - this.retentionMs;
    const dropped = this.messages.filter((m) => m.time < cutoff);
    this.messages = this.messages.filter((m) => m.time >= cutoff);

    // Limit łącznego rozmiaru plików – najpierw znikają najstarsze.
    let total = this.messages.reduce((sum, m) => sum + (m.kind === 'file' ? m.size : 0), 0);
    while (total > this.maxBytes) {
      const idx = this.messages.findIndex((m) => m.kind === 'file');
      if (idx < 0) break;
      const [old] = this.messages.splice(idx, 1);
      total -= old.size;
      dropped.push(old);
    }

    await Promise.all(
      dropped
        .filter((m) => m.kind === 'file')
        .map((m) => fs.unlink(path.join(this.filesDir, m.id)).catch(() => {}))
    );
    if (dropped.length) this.scheduleSave();
    return dropped.length;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      for (const [file, value] of [
        [this.metaPath, this.messages],
        [this.accountsPath, Array.from(this.accounts.values())],
      ]) {
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(value));
        await fs.rename(tmp, file);
      }
    } catch (err) {
      console.error('Nie udało się zapisać historii:', err.message);
    }
  }
}

class MongoStore {
  constructor({ uri, dbName, retentionMs }) {
    this.uri = uri;
    this.dbName = dbName;
    this.retentionMs = retentionMs;
  }

  get label() {
    return 'MongoDB';
  }

  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    this.col = this.client.db(this.dbName).collection('messages');
    this.accountsCol = this.client.db(this.dbName).collection('accounts');
    await this.accountsCol.createIndex({ tokenHash: 1 }, { unique: true });
    await this.accountsCol.createIndex({ nickLower: 1 }, { unique: true });
    await this.col.createIndex({ time: 1 });
    // Indeks TTL: MongoDB sam usuwa dokumenty po upływie czasu od `createdAt`.
    await this.col.createIndex({ createdAt: 1 }, { expireAfterSeconds: Math.ceil(this.retentionMs / 1000) });
  }

  async loadAccounts() {
    const docs = await this.accountsCol.find({}).toArray();
    return docs.map(({ _id, nickLower, ...rest }) => rest);
  }

  async saveAccount(account) {
    // nickLower służy tylko do indeksu unikalności nicków w bazie
    const doc = { _id: account.id, ...account, nickLower: account.nick.toLowerCase() };
    await this.accountsCol.replaceOne({ _id: account.id }, doc, { upsert: true });
  }

  async add(msg) {
    await this.col.insertOne({ _id: msg.id, ...msg, createdAt: new Date(msg.time) });
  }

  async recent(since, limit) {
    const docs = await this.col
      .find({ time: { $gte: since } }, { projection: { data: 0, _id: 0, createdAt: 0 } })
      .sort({ time: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse();
  }

  async fileData(id) {
    const since = Date.now() - this.retentionMs;
    const doc = await this.col.findOne(
      { _id: id, kind: 'file', time: { $gte: since } },
      { projection: { data: 1 } }
    );
    if (!doc || !doc.data) return null;
    const d = doc.data;
    if (Buffer.isBuffer(d)) return d;
    return Buffer.from(d.buffer.subarray(0, d.position ?? d.buffer.length));
  }

  async prune() {
    return 0; // robi to indeks TTL
  }

  async flush() {
    await this.client.close();
  }
}

function createStore({ retentionMs, dataDir, maxStorageBytes, mongoUri, mongoDb }) {
  if (mongoUri) return new MongoStore({ uri: mongoUri, dbName: mongoDb, retentionMs });
  return new FileStore({ dir: dataDir, retentionMs, maxBytes: maxStorageBytes });
}

module.exports = { createStore };

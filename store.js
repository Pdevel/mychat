// Magazyn historii czatu. Wiadomości i pliki starsze niż `retentionMs` są automatycznie usuwane.
//
//  - FileStore  (domyślny): metadane w pamięci + zrzut JSON, bajty plików jako osobne pliki na dysku.
//                           Na darmowym Renderze dysk jest tymczasowy – dane znikają przy restarcie/uśpieniu.
//  - MongoStore (gdy ustawiono MONGODB_URI): trwała historia w MongoDB (np. darmowy Atlas),
//                           usuwanie po czasie realizuje indeks TTL.

const fs = require('fs/promises');
const path = require('path');

const TOMBSTONE_MS = 365 * 24 * 60 * 60 * 1000; // jak długo pamiętamy, że wiadomość usunięto

class FileStore {
  constructor({ dir, retentionMs, maxBytes }) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.metaPath = path.join(dir, 'messages.json');
    this.retentionMs = retentionMs;
    this.maxBytes = maxBytes;
    this.accountsPath = path.join(dir, 'accounts.json');
    this.deletedPath = path.join(dir, 'deleted.json');
    this.emojiPath = path.join(dir, 'emoji.json');
    this.emoji = new Map(); // id -> własne emoji serwera (z obrazem jako data-URL)
    this.tombstones = []; // [{ id, at }] – ślady usuniętych wiadomości, żeby urządzenia mogły wyczyścić archiwum
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
    try {
      this.tombstones = JSON.parse(await fs.readFile(this.deletedPath, 'utf8'));
    } catch {
      this.tombstones = [];
    }
    try {
      const list = JSON.parse(await fs.readFile(this.emojiPath, 'utf8'));
      this.emoji = new Map(list.map((e) => [e.id, e]));
    } catch {
      this.emoji = new Map();
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

  // Wiadomości sprzed wprowadzenia kanałów nie mają pola `channel` – należą do kanału „ogolny”.
  async recent(since, limit, channel = 'ogolny') {
    return this.messages.filter((m) => m.time >= since && (m.channel || 'ogolny') === channel).slice(-limit);
  }

  async get(id) {
    return this.messages.find((m) => m.id === id) || null;
  }

  // ---------- Własne emoji serwera ----------
  async loadEmoji() {
    return Array.from(this.emoji.values());
  }

  async saveEmoji(emoji) {
    this.emoji.set(emoji.id, { ...emoji });
    this.scheduleSave();
  }

  async deleteEmoji(id) {
    this.emoji.delete(id);
    this.scheduleSave();
  }

  // ---------- Reakcje: { emoji: [accountId, ...] } przechowywane razem z wiadomością ----------
  async setReactions(id, reactions) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return false;
    if (Object.keys(reactions).length) msg.reactions = reactions;
    else delete msg.reactions;
    this.scheduleSave();
    return true;
  }

  // Zapamiętuje, że wiadomość została usunięta przez autora (na rok – tyle, ile urządzenia mogą być offline).
  async addTombstone(id) {
    this.tombstones.push({ id, at: Date.now() });
    this.scheduleSave();
  }

  async tombstonesSince(since, limit = 20000) {
    return this.tombstones.filter((t) => t.at > since).slice(0, limit).map((t) => t.id);
  }

  async remove(id) {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    const [msg] = this.messages.splice(idx, 1);
    if (msg.kind === 'file') await fs.unlink(path.join(this.filesDir, msg.id)).catch(() => {});
    this.scheduleSave();
    return true;
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

    const tombstoneCutoff = Date.now() - TOMBSTONE_MS;
    if (this.tombstones.some((t) => t.at < tombstoneCutoff)) {
      this.tombstones = this.tombstones.filter((t) => t.at >= tombstoneCutoff);
      this.scheduleSave();
    }

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
        [this.deletedPath, this.tombstones],
        [this.emojiPath, Array.from(this.emoji.values())],
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
    this.emojiCol = this.client.db(this.dbName).collection('emoji');
    this.deletedCol = this.client.db(this.dbName).collection('deleted');
    await this.deletedCol.createIndex({ at: 1 });
    await this.deletedCol.createIndex({ atDate: 1 }, { expireAfterSeconds: Math.ceil(TOMBSTONE_MS / 1000) });
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

  async recent(since, limit, channel = 'ogolny') {
    const filter = { time: { $gte: since } };
    if (channel === 'ogolny') {
      filter.$or = [{ channel: 'ogolny' }, { channel: { $exists: false } }]; // starsze wiadomości bez kanału
    } else {
      filter.channel = channel;
    }
    const docs = await this.col
      .find(filter, { projection: { data: 0, _id: 0, createdAt: 0 } })
      .sort({ time: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse();
  }

  async get(id) {
    return this.col.findOne({ _id: id }, { projection: { data: 0, _id: 0, createdAt: 0 } });
  }

  async loadEmoji() {
    const docs = await this.emojiCol.find({}).toArray();
    return docs.map(({ _id, ...rest }) => rest);
  }

  async saveEmoji(emoji) {
    await this.emojiCol.replaceOne({ _id: emoji.id }, { _id: emoji.id, ...emoji }, { upsert: true });
  }

  async deleteEmoji(id) {
    await this.emojiCol.deleteOne({ _id: id });
  }

  async setReactions(id, reactions) {
    const has = Object.keys(reactions).length > 0;
    const res = await this.col.updateOne({ _id: id }, has ? { $set: { reactions } } : { $unset: { reactions: '' } });
    return res.matchedCount > 0;
  }

  async addTombstone(id) {
    const at = Date.now();
    await this.deletedCol.replaceOne({ _id: id }, { _id: id, at, atDate: new Date(at) }, { upsert: true });
  }

  async tombstonesSince(since, limit = 20000) {
    const docs = await this.deletedCol.find({ at: { $gt: since } }).sort({ at: 1 }).limit(limit).toArray();
    return docs.map((d) => d._id);
  }

  async remove(id) {
    const res = await this.col.deleteOne({ _id: id });
    return res.deletedCount > 0;
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

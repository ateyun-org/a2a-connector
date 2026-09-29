import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A small durable index. Writes are serialized and atomically renamed. */
export class ConversationStore {
  constructor(path) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.conversations)) throw new Error('invalid A2A conversation store');
      return value.conversations;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async list(parentId) {
    await this.pending;
    return (await this.read()).filter(item => item.parentId === parentId);
  }

  async get(id) {
    await this.pending;
    return (await this.read()).find(item => item.id === id);
  }

  async put(item) {
    const operation = this.pending.then(async () => {
      const records = await this.read();
      const index = records.findIndex(record => record.id === item.id);
      if (index < 0) records.push(item);
      else records[index] = item;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, conversations: records }, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

import type { DatabaseSync } from 'node:sqlite';
import { db } from './db/database.js';

export abstract class Store {
  protected static readonly db: DatabaseSync = db;
}

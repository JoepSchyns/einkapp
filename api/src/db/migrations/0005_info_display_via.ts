import type { DatabaseSync } from 'node:sqlite';

/** Info displays can be reached through our own BLE service or through Home Assistant */
export function up(db: DatabaseSync) {
  db.exec(`ALTER TABLE session_ble_devices ADD COLUMN via TEXT NOT NULL DEFAULT 'bluetooth'`);
}

export function down(db: DatabaseSync) {
  db.exec(`ALTER TABLE session_ble_devices DROP COLUMN via`);
}

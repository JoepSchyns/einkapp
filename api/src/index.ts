import { migrate } from './db/migrate.js';

// Migrations must finish before any store-using module is evaluated (admin.ts seeds a user on import)
await migrate();
await import('./server.js');

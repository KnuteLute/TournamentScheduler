import * as path from 'path';
import { applyMigrations } from '../src/persistence/migrations';

async function main(): Promise<void> {
  const directory = path.resolve(__dirname, '../db/migrations');
  const result = await applyMigrations(directory);
  // Report schema versions only; never print connection configuration.
  console.log(JSON.stringify(result));
}

main().catch(() => {
  console.error('Migration failed; see database operator diagnostics without exposing connection details.');
  process.exitCode = 1;
});

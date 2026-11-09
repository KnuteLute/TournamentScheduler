import { promises as fs } from 'fs';
import * as path from 'path';
import { PostgresDatabase } from '../src/persistence/database';
import { importLegacyPostgres, inspectLocalJson, MAX_LOCAL_IMPORT_BYTES, reconcileLegacyData } from '../src/persistence/legacy-import';

interface Options {
  source: 'postgres' | 'local-json';
  files: string[];
  apply: boolean;
  reconcile: boolean;
}

function parseArgs(args: string[]): Options {
  let source: Options['source'] = 'local-json';
  const files: string[] = [];
  let apply = false;
  let reconcile = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--source') {
      const value = args[++index];
      if (value !== 'postgres' && value !== 'local-json') throw new Error('Invalid source');
      source = value;
    } else if (arg === '--file') {
      const value = args[++index];
      if (!value) throw new Error('Missing file path');
      files.push(path.resolve(value));
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--reconcile') {
      reconcile = true;
    } else if (arg === '--dry-run') {
      apply = false;
    } else {
      throw new Error('Unknown option');
    }
  }
  if (files.length === 0) {
    const cwd = process.cwd();
    const webDirectory = path.basename(cwd) === 'web' ? cwd : path.join(cwd, 'web');
    files.push(path.join(webDirectory, '.local-data/offline-db.json'));
  }
  if (source === 'postgres' && files.length > 0 && args.includes('--file')) throw new Error('--file is only valid for local-json sources');
  return { source, files, apply, reconcile };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const needsDatabase = options.reconcile || options.source === 'postgres' || options.apply;
  const db = needsDatabase ? new PostgresDatabase() : null;
  try {
    if (options.reconcile) {
      console.log(JSON.stringify({ mode: 'reconciliation', counts: await reconcileLegacyData(db!) }));
      return;
    }
    const summary = options.source === 'postgres'
      ? await importLegacyPostgres(db!, options.apply)
      : await Promise.all(options.files.map(async file => {
        const stat = await fs.stat(file);
        if (stat.size > MAX_LOCAL_IMPORT_BYTES) {
          return {
            source: 'local_json' as const,
            sourceLabel: path.basename(file).match(/^(offline-db|players_index|tournament_history|match_history)\.json$/)
              ? path.basename(file) : 'local-json-source',
            dryRun: !options.apply, counts: {}, quarantined: 0, needsReview: 1, noOp: false,
            warnings: ['source_exceeds_size_limit'],
          };
        }
        return inspectLocalJson(db, file, await fs.readFile(file), options.apply);
      }));
    console.log(JSON.stringify(summary));
  } finally {
    if (db) await db.close();
  }
}

main().catch(() => {
  console.error('Legacy import failed; verify source shape and database readiness without exposing credentials.');
  process.exitCode = 1;
});

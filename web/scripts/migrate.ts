import * as path from 'path';
import { applyMigrations, migrationStatus } from '../src/persistence/migrations';

async function main(): Promise<void> {
  const args=process.argv.slice(2);
  if(args.some(arg=>!['--apply','--status','--dry-run'].includes(arg))||args.includes('--apply')&&(args.includes('--status')||args.includes('--dry-run'))){
    throw new Error('Use either --apply or --status; default mode is read-only status.');
  }
  const directory = path.resolve(__dirname, '../db/migrations');
  if(args.includes('--apply')){
    const result=await applyMigrations(directory);
    console.log(JSON.stringify({mode:'apply',...result}));
  }else{
    const result=await migrationStatus(directory);
    console.log(JSON.stringify({mode:'status',...result}));
  }
}

main().catch(() => {
  console.error('Migration command failed; verify database readiness without exposing connection details.');
  process.exitCode = 1;
});

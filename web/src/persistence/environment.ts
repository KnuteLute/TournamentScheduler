import * as path from 'path';
import * as dotenv from 'dotenv';
import process from 'process';

/** Load the repository-root .env only for explicit persistence CLIs. */
export function loadPersistenceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot = path.resolve(__dirname, '../../../'),
): NodeJS.ProcessEnv {
  const result = dotenv.config({
    path: path.join(repositoryRoot, '.env'),
    processEnv: env,
    override: false,
    quiet: true,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error && error.code !== 'ENOENT') {
    throw new Error('Unable to load repository environment configuration');
  }
  return env;
}

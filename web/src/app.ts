import express, { type Express, type Request, type Response } from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { createApiRouter } from './api/router';
import { ApiProblem, sendProblem } from './api/problem';
import { createApiConfig, type ApiConfig } from './config/api';
import type { ApiStore, RateLimitRequest, RateLimitDecision, SessionRecord, AccountCredential, StoreRequest, StoreResult } from './services/ports';

declare const require: (id: string) => unknown;

export interface ApplicationOptions {
  staticDirectory?: string;
  production?: boolean;
}

function setSecurityHeaders(response: Response, production: boolean): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  );
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendNotFound(_request: Request, response: Response): void {
  sendProblem(
    response,
    new ApiProblem(404, 'not-found', 'Not Found', 'The requested route was not found.'),
    randomUUID(),
  );
}

function lazyPostgresStore(): ApiStore {
  let resolved: ApiStore | undefined;
  const getStore = (): ApiStore => {
    if (!resolved) {
      const module = require('./persistence/api-store') as { createPostgresApiStore?: () => ApiStore };
      if (typeof module.createPostgresApiStore !== 'function') {
        throw new Error('PostgreSQL API persistence is not configured.');
      }
      resolved = module.createPostgresApiStore();
    }
    return resolved;
  };

  return {
    lookupSessionByTokenHash: (tokenHash: Uint8Array, now: Date): Promise<SessionRecord | null> =>
      getStore().lookupSessionByTokenHash(tokenHash, now),
    findAccountByUsernameKey: (usernameKey: string): Promise<AccountCredential | null> =>
      getStore().findAccountByUsernameKey(usernameKey),
    consumeRateLimit: (input: RateLimitRequest): Promise<RateLimitDecision> =>
      getStore().consumeRateLimit(input),
    execute: <T = unknown>(request: StoreRequest): Promise<StoreResult<T>> =>
      getStore().execute<T>(request),
    healthCheck: async (): Promise<boolean> => {
      const healthCheck = getStore().healthCheck;
      return healthCheck ? healthCheck() : false;
    },
  };
}

/**
 * Build the same-origin application. All JSON operations go through the
 * owner-scoped v1 API; legacy EJS handlers and process-global tournament state
 * are deliberately not mounted.
 */
export function createApplication(
  store: ApiStore,
  config: ApiConfig,
  options: ApplicationOptions = {},
): Express {
  const application = express();
  const production = options.production ?? config.production;
  const staticDirectory = path.resolve(
    options.staticDirectory ?? path.join(__dirname, '../public'),
  );
  const spaEntry = path.join(staticDirectory, 'app', 'index.html');

  application.disable('x-powered-by');
  application.use((_request, response, next) => {
    setSecurityHeaders(response, production);
    next();
  });
  application.use('/api/v1', createApiRouter(store, config));

  application.use(express.static(staticDirectory, {
    index: false,
    fallthrough: true,
    setHeaders(response, filePath) {
      if (filePath.endsWith(`${path.sep}index.html`)) {
        response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  application.get('/', (_request, response) => response.redirect(303, '/app/'));
  application.get(['/app', '/app/*'], (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.sendFile(spaEntry, (error) => {
      if (error && !response.headersSent) next(error);
    });
  });

  application.use('/api', (request, response) => sendNotFound(request, response));
  application.use((request, response) => sendNotFound(request, response));
  application.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
    if (response.headersSent) return;
    sendProblem(
      response,
      new ApiProblem(500, 'internal-error', 'Internal Server Error', 'The request could not be completed.'),
      randomUUID(),
    );
  });

  return application;
}

const defaultConfig = createApiConfig();
const defaultStore = lazyPostgresStore();
const app = createApplication(defaultStore, defaultConfig);

export default app;

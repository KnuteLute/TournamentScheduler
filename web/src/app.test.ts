import assert = require('node:assert/strict');
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request = require('supertest');
import { createApplication } from './app';
import { createApiConfig } from './config/api';
import type { ApiStore } from './services/ports';

const config = createApiConfig({
  NODE_ENV: 'test',
  API_ORIGIN: 'http://127.0.0.1:3000',
  API_SESSION_HASH_SECRET: Buffer.alloc(32, 13).toString('base64url'),
});

function testStore(ready = true): ApiStore {
  return {
    lookupSessionByTokenHash: async () => null,
    findAccountByUsernameKey: async () => null,
    consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    execute: async <T>() => ({ value: {} as T }),
    healthCheck: async () => ready,
  };
}

describe('same-origin application composition', () => {
  it('does not expose legacy state-changing GET routes and applies security headers', async () => {
    const app = createApplication(testStore(), config);
    const response = await request(app).get('/tournament/next');

    assert.equal(response.status, 404);
    assert.match(response.headers['content-type'], /application\/problem\+json/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  });

  it('serves the Vue app with no-store HTML and returns dependency-free liveness', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tournament-app-'));
    try {
      await mkdir(path.join(directory, 'app'));
      await writeFile(path.join(directory, 'app', 'index.html'), '<!doctype html><title>test app</title>');
      const app = createApplication(testStore(), config, { staticDirectory: directory });

      const root = await request(app).get('/');
      assert.equal(root.status, 303);
      assert.equal(root.headers.location, '/app/');

      const ui = await request(app).get('/app/').set('Accept', 'text/html');
      assert.equal(ui.status, 200);
      assert.match(ui.headers['cache-control'], /no-store/);
      assert.match(ui.text, /test app/);

      const live = await request(app).get('/api/v1/health/live');
      assert.equal(live.status, 200);
      assert.deepEqual(live.body, { status: 'live' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports readiness failure without leaking backend details', async () => {
    const app = createApplication(testStore(false), config);
    const response = await request(app).get('/api/v1/health/ready');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: 'not_ready' });
  });

  it('rate limits public file-serving requests without throttling API liveness', async () => {
    const app = createApplication(testStore(), config, { publicFileRequestLimit: 2 });
    await request(app).get('/').expect(303);
    await request(app).get('/').expect(303);
    const blocked = await request(app).get('/');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate-limited');
    assert.ok(blocked.headers['retry-after']);
    await request(app).get('/api/v1/health/live').expect(200);
  });
});

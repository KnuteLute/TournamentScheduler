import app from './app';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

if (process.env.VERCEL !== '1' && process.env.VERCEL !== 'true') {
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(port, host, () => {
    process.stdout.write(`Tournament Scheduler listening on http://${host}:${port}\n`);
  });
}

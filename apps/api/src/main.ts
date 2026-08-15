import { createApiApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const server = createApiApp().listen(port, '127.0.0.1', () => {
  console.log(`API shell listening on http://127.0.0.1:${port}`);
});

function shutdown(): void {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

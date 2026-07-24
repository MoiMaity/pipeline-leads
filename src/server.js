import { createApp } from './app.js';
import { getDb, closeDb } from './lib/db.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production';

getDb(); // fail fast if the database cannot be opened

const server = createApp({ trustProxy });

server.listen(port, host, () => {
  console.log(`Pipeline listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}

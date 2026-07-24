import http from 'node:http';
import {
  createRouter,
  readBody,
  json,
  errors,
  HttpError,
} from './lib/http.js';
import { resolveAuth, purgeExpiredSessions } from './lib/auth.js';
import { registerApiRoutes } from './routes/api.js';
import { registerUiRoutes, renderHtmlError } from './routes/ui.js';

export function createApp({ trustProxy = false } = {}) {
  const router = createRouter();
  registerUiRoutes(router);
  registerApiRoutes(router);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname.startsWith('/api/');
    const secure =
      trustProxy && (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

    const ctx = {
      req,
      res,
      url,
      query: url.searchParams,
      params: {},
      body: {},
      user: null,
      session: null,
      secure,
      isApi,
    };

    try {
      const match = router.match(req.method, url.pathname);
      if (!match) throw errors.notFound(isApi ? 'No such endpoint.' : 'Page not found.');

      ctx.params = match.params;
      ctx.body = await readBody(req);

      const auth = resolveAuth(req);
      ctx.user = auth.user;
      ctx.session = auth.session;

      await match.route.handler(ctx);
      if (!res.writableEnded) res.end();
    } catch (err) {
      handleError(ctx, err);
    }
  });

  server.on('listening', () => {
    try {
      purgeExpiredSessions();
    } catch {
      /* database may not be writable yet in some environments */
    }
  });

  return server;
}

function handleError(ctx, err) {
  const { res, isApi } = ctx;
  if (res.writableEnded) return;

  const isKnown = err instanceof HttpError;
  const status = isKnown ? err.status : 500;

  if (!isKnown) {
    console.error('[error]', ctx.req.method, ctx.url?.pathname, err);
  }

  const headers = {};
  if (err.allow) headers.Allow = err.allow;
  if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);

  if (isApi) {
    return json(
      res,
      status,
      {
        error: {
          code: isKnown ? err.code : 'internal_error',
          message: isKnown ? err.message : 'Something went wrong on our end.',
          ...(isKnown && err.details ? { details: err.details } : {}),
        },
      },
      headers,
    );
  }

  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  return renderHtmlError(ctx, isKnown ? err : { status: 500, message: '' });
}

/**
 * Express adapter.
 *
 * All this does is translate between Express and the framework-agnostic
 * `HttpRequest` / `HttpResponse` shapes that `http/router.ts` works with — the
 * router holds every routing decision and is fully covered by tests that never
 * boot a server. Swapping Express out means rewriting this file and nothing else.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildOpenApiDocument } from '@acc/contracts';

import { RateLimiter } from './http/rate-limit.ts';
import { createRouter } from './http/router.ts';
import type { HttpMethod, HttpRequest } from './http/types.ts';
import type { Container } from './container.ts';

const MAX_BODY_BYTES = '1mb';

export function createExpressApp(container: Container): Express {
  const app = express();
  const router = createRouter({
    missions: container.missions,
    providers: container.providers,
    madre: container.madre.service,
    sitePublisher: container.sitePublisher,
    siteSettings: { hasToken: container.config.githubToken !== undefined, repo: container.config.githubSitesRepo ?? null },
    logger: container.logger,
    version: container.config.version,
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_BYTES }));
  app.use(cors(container.config.corsOrigins));
  app.use(rateLimit(container.config.rateLimit));
  if (container.config.accessPassword !== undefined) app.use(requirePassword(container.config.accessPassword));

  // Malformed JSON arrives here as a SyntaxError from express.json. Without
  // this it would surface as an opaque 500.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'El cuerpo de la petición no es JSON válido.', issues: [] },
      });
      return;
    }
    next(error);
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument(container.config.version));
  });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }

    const request: HttpRequest = {
      method: req.method as HttpMethod,
      path: req.path,
      query: normaliseQuery(req.query),
      body: req.body,
      headers: normaliseHeaders(req.headers),
    };

    try {
      const response = await router.handle(request);
      for (const [key, value] of Object.entries(response.headers ?? {})) res.setHeader(key, value);
      res.status(response.status).json(response.body);
    } catch (error) {
      // The router handles its own errors; reaching here means the adapter
      // itself broke.
      container.logger.error('adapter failure', {
        path: req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: { code: 'internal_error', message: 'Ha ocurrido un error inesperado.', issues: [] },
      });
    }
  });

  // Production: the same process serves the built web app, so the browser stays
  // same-origin (no CORS) and the site sits behind the same password as the API.
  const webDir = resolve(container.config.webDistDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'));
  if (existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDir, 'index.html'));
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'not_found', message: `Ninguna ruta coincide con ${req.method} ${req.path}.`, issues: [] },
    });
  });

  // Catch-all. Express 5's default handler renders HTML, which would break a
  // client that has only ever been given JSON. Registered last so it sees
  // anything the handlers above let through.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    container.logger.error('unhandled request error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'internal_error', message: 'Ha ocurrido un error inesperado.', issues: [] },
    });
  });

  return app;
}

/**
 * Stops one runaway client from saturating the API.
 *
 * In-process and per address, so it is a guard rail rather than a security
 * control: it catches retry storms and stuck polling loops. The ceiling is well
 * above what the app itself needs. `OPTIONS` is exempt so a blocked client
 * still gets a CORS answer instead of an opaque failure.
 */
function rateLimit(options: { max: number; windowMs: number }) {
  const limiter = new RateLimiter(options);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const verdict = limiter.check(key);
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(verdict.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((verdict.resetAt - Date.now()) / 1000)));
    if (verdict.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    res.status(429).json({
      error: {
        code: 'rate_limited',
        message: `Demasiadas peticiones. Vuelve a intentarlo en ${verdict.retryAfterSeconds} s.`,
        issues: [],
      },
    });
  };
}

/**
 * Shared-password gate (HTTP Basic; the username is ignored). Safari and every
 * other browser remember the credentials and resend them on same-origin fetches,
 * so the app needs no login screen. `/api/health` stays open so a host can probe
 * it; it reports no data. Compared as SHA-256 digests in constant time.
 */
export function requirePassword(password: string) {
  const expected = createHash('sha256').update(password).digest();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/api/health' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const given = createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
      if (timingSafeEqual(given, expected)) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="AI Command Center", charset="UTF-8"');
    res.status(401).json({ error: { code: 'unauthorized', message: 'Se necesita la contraseña de acceso.', issues: [] } });
  };
}

/**
 * Minimal CORS. The API is same-origin in production (the frontend is served as
 * static files); this exists for `vite dev` on a different port.
 */
function cors(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/** Express gives `string | string[] | ParsedQs`; the router wants flat strings. */
function normaliseQuery(query: unknown): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (typeof query !== 'object' || query === null) return result;

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') result[key] = value[0];
  }
  return result;
}

function normaliseHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') result[key] = value[0];
  }
  return result;
}

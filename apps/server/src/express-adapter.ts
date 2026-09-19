/**
 * Express adapter.
 *
 * All this does is translate between Express and the framework-agnostic
 * `HttpRequest` / `HttpResponse` shapes that `http/router.ts` works with — the
 * router holds every routing decision and is fully covered by tests that never
 * boot a server. Swapping Express out means rewriting this file and nothing else.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildOpenApiDocument } from '@acc/contracts';

import { createRouter } from './http/router.ts';
import type { HttpMethod, HttpRequest } from './http/types.ts';
import type { Container } from './container.ts';

const MAX_BODY_BYTES = '1mb';

export function createExpressApp(container: Container): Express {
  const app = express();
  const router = createRouter({
    missions: container.missions,
    providers: container.providers,
    logger: container.logger,
    version: container.config.version,
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_BYTES }));
  app.use(cors(container.config.corsOrigins));

  // Malformed JSON arrives here as a SyntaxError from express.json. Without
  // this it would surface as an opaque 500.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'The request body is not valid JSON.', issues: [] },
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
        error: { code: 'internal_error', message: 'An unexpected error occurred.', issues: [] },
      });
    }
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'not_found', message: `No route matches ${req.method} ${req.path}.`, issues: [] },
    });
  });

  return app;
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
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

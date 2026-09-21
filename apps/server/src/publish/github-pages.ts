/**
 * Publishes a finished single-file website to GitHub Pages, for free.
 *
 * One repository the owner made for this (public, Pages on) and ONE token
 * limited to it (fine-grained: Contents write, Pages write). Each site goes into
 * its own folder, `<repo>/<slug>/index.html`, and is served at
 * `https://<owner>.github.io/<repo>/<slug>/`. The token never leaves the server
 * and never appears in an error message.
 *
 * Nothing here decides *whether* to publish: it is only called from an endpoint
 * a person triggers with a button, and the page it receives has already passed
 * `checkSiteHtml`. It is checked again here anyway — this is the last door.
 */

import { checkSiteHtml } from '@acc/domain';

export interface HttpResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type GitHubFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HttpResult>;

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface PublishedSite {
  url: string;
  path: string;
  commitUrl: string | null;
  /** Something the owner still has to do, e.g. switch Pages on. */
  note: string | null;
}

export interface SitePublisher {
  readonly repo: string;
  publish(input: { slug: string; html: string; message?: string }): Promise<PublishedSite>;
}

const API = 'https://api.github.com';
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseRepo(value: string): { owner: string; name: string } | null {
  const m = REPO.exec(value.trim());
  return m === null ? null : { owner: m[1]!, name: m[2]! };
}

export class GitHubPagesPublisher implements SitePublisher {
  readonly repo: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly token: string,
    repo: string,
    private readonly fetchImpl: GitHubFetch = (url, init) => globalThis.fetch(url, init as RequestInit) as unknown as Promise<HttpResult>,
  ) {
    const parsed = parseRepo(repo);
    if (parsed === null) throw new Error(`GITHUB_SITES_REPO must look like "owner/repository", got "${repo}".`);
    this.owner = parsed.owner;
    this.name = parsed.name;
    this.repo = `${parsed.owner}/${parsed.name}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: HttpResult;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'AICommandCenter',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PublishError('No se pudo contactar con GitHub. Inténtalo de nuevo en un momento.');
    }
    const json = rec(await response.json().catch(() => null));
    return { status: response.status, json };
  }

  async publish(input: { slug: string; html: string; message?: string }): Promise<PublishedSite> {
    if (!SLUG.test(input.slug)) throw new PublishError('El nombre de la carpeta no es válido.', 400);
    const problems = checkSiteHtml(input.html);
    if (problems.length > 0) throw new PublishError(`La página no se puede publicar: ${problems.join('; ')}.`, 422);

    const repoPath = `/repos/${this.owner}/${this.name}`;

    // 1. The repository: it must exist, be reachable with this token, and be public
    //    (GitHub Pages is free only for public repositories).
    const repo = await this.call('GET', repoPath);
    if (repo.status === 401) throw new PublishError('GitHub rechazó el token (GITHUB_TOKEN). Crea uno nuevo y cámbialo en Render.', 502);
    if (repo.status === 404) throw new PublishError(`No encuentro el repositorio ${this.repo}, o el token no tiene acceso a él.`, 502);
    if (repo.status !== 200) throw new PublishError(`GitHub respondió con el código ${repo.status} al abrir el repositorio.`);
    if (repo.json['private'] === true) throw new PublishError(`El repositorio ${this.repo} es privado y GitHub Pages solo es gratis con repositorios públicos. Hazlo público en Settings.`, 409);
    const branch = typeof repo.json['default_branch'] === 'string' ? repo.json['default_branch'] : 'main';

    // 2. The file. An existing folder is updated, not refused: republishing is normal.
    const filePath = `${input.slug}/index.html`;
    const contentsPath = `${repoPath}/contents/${filePath}`;
    const existing = await this.call('GET', `${contentsPath}?ref=${encodeURIComponent(branch)}`);
    const sha = existing.status === 200 && typeof existing.json['sha'] === 'string' ? existing.json['sha'] : undefined;
    const put = await this.call('PUT', contentsPath, {
      message: input.message ?? `Publicar ${input.slug}`,
      content: Buffer.from(input.html, 'utf8').toString('base64'),
      branch,
      ...(sha !== undefined ? { sha } : {}),
    });
    if (put.status === 403 || put.status === 404) {
      throw new PublishError('El token no puede escribir en el repositorio. Necesita el permiso «Contents: Read and write» sobre ese repositorio.', 502);
    }
    if (put.status !== 200 && put.status !== 201) {
      const detail = typeof put.json['message'] === 'string' ? `: ${put.json['message'].slice(0, 160)}` : '';
      throw new PublishError(`GitHub no guardó el archivo (código ${put.status})${detail}`);
    }
    const commit = rec(put.json['commit']);
    const commitUrl = typeof commit['html_url'] === 'string' ? commit['html_url'] : null;

    // 3. Pages on. Best effort: without the Pages permission the file is still saved
    //    and the owner is told the one switch to flip.
    let note: string | null = null;
    const pages = await this.call('GET', `${repoPath}/pages`);
    if (pages.status === 404) {
      const enabled = await this.call('POST', `${repoPath}/pages`, { source: { branch, path: '/' } });
      if (enabled.status !== 201 && enabled.status !== 409) {
        note = `Falta activar GitHub Pages: en el repositorio ve a Settings → Pages, elige la rama «${branch}» y la carpeta «/ (root)», y pulsa Save.`;
      }
    } else if (pages.status !== 200) {
      note = 'No pude comprobar si GitHub Pages está activo. Si la dirección no abre, revisa Settings → Pages en el repositorio.';
    }

    const base = this.name.toLowerCase() === `${this.owner.toLowerCase()}.github.io` ? '' : `/${this.name}`;
    return { url: `https://${this.owner.toLowerCase()}.github.io${base}/${input.slug}/`, path: filePath, commitUrl, note };
  }
}

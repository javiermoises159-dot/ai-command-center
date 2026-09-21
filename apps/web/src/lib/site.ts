/**
 * Client for the site-publishing endpoints. The GitHub token lives on the
 * server; the browser only asks it to publish and receives the public address.
 */

export interface SitePublishingStatus {
  configured: boolean;
  repo: string | null;
  hasToken: boolean;
  repoSetting: string | null;
}

export interface PublishedSite {
  url: string;
  path: string;
  commitUrl: string | null;
  note: string | null;
}

async function errorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message : `El servidor respondió con el código ${response.status}.`;
}

export async function getSiteStatus(): Promise<SitePublishingStatus> {
  const response = await fetch('/api/site/status');
  if (!response.ok) throw new Error(await errorMessage(response));
  const payload = (await response.json()) as { publishing: SitePublishingStatus };
  return payload.publishing;
}

export async function publishSite(missionId: string, whatsapp: string): Promise<PublishedSite> {
  let response: Response;
  try {
    response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/site/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ whatsapp }) });
  } catch {
    throw new Error('No se pudo conectar con el servidor.');
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  return ((await response.json()) as { site: PublishedSite }).site;
}

/** A downloadable copy of the page. */
export function htmlDownloadUrl(html: string): string {
  return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
}

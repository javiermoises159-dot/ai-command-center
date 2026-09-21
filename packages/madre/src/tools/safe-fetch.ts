/**
 * Fetching a web page on behalf of an agent, safely.
 *
 * The URL comes from a mission or from a search result, so it is untrusted: it
 * must not be able to make this server call its own network (localhost, cloud
 * metadata, a database on a private address). The rules:
 *
 *  - only http(s), no credentials in the URL, only ports 80 and 443;
 *  - the address is checked when the connection is made (a custom `lookup`), so
 *    a name that resolves to a private address, or changes its answer between
 *    a check and a connection, is refused;
 *  - redirects are followed by hand, at most 3, and each hop goes through the
 *    same checks;
 *  - only text-like content, capped in size and time; no cookies, no body sent.
 *
 * The text that comes back is DATA for a model to read, never instructions.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class UnsafeUrlError extends Error {}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

export type PageFetcher = (url: string, options?: { signal?: AbortSignal; maxBytes?: number }) => Promise<FetchedPage>;

const USER_AGENT = 'AICommandCenter/1.0 (research assistant)';
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|json|xml)|application\/[\w.+-]*\+(json|xml))/i;

/** True for any address that is not a public, routable one. */
export function isPrivateAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) return isPrivateV4(address.split('.').map(Number) as [number, number, number, number]);
  if (kind === 6) {
    const a = address.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    if (a === '::' || a === '::1') return true;
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff')) return true; // unique-local, link-local, multicast
    if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8') || a.startsWith('2002:') || a.startsWith('100:')) return true;
    return false;
  }
  return true; // not an IP at all: refuse rather than guess
}

function isPrivateV4([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Throws `UnsafeUrlError` unless the URL is one this module is willing to request. */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('La dirección no es una URL válida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('Solo se permiten direcciones http y https.');
  if (url.username !== '' || url.password !== '') throw new UnsafeUrlError('No se permiten direcciones con usuario o contraseña.');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new UnsafeUrlError('Solo se permiten los puertos 80 y 443.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || (!host.includes('.') && net.isIP(host) === 0 && !host.includes(':'))) throw new UnsafeUrlError('La dirección no apunta a un sitio público.');
  if (net.isIP(host) !== 0 && isPrivateAddress(host)) throw new UnsafeUrlError('La dirección apunta a una red privada.');
  return url;
}

function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) return callback(error);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new UnsafeUrlError('La dirección apunta a una red privada.') as NodeJS.ErrnoException);
    }
    if (options.all === true) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

export const fetchPage: PageFetcher = async (rawUrl, options = {}) => {
  let current = assertSafeUrl(rawUrl);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(current, maxBytes, options.signal);
    if (result.redirect === null) {
      const { html, ...page } = result;
      return { ...page, title: extractTitle(html), text: extractText(html, result.contentType), url: current.toString() };
    }
    current = assertSafeUrl(new URL(result.redirect, current).toString());
  }
  throw new UnsafeUrlError('Demasiadas redirecciones.');
};

interface RawResponse {
  status: number;
  contentType: string;
  html: string;
  truncated: boolean;
  redirect: string | null;
}

function requestOnce(url: URL, maxBytes: number, signal?: AbortSignal): Promise<RawResponse & { title: null; text: string; url: string }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' }, lookup: guardedLookup as never, timeout: 10_000 },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string') {
          response.resume();
          resolve({ status, contentType: '', html: '', truncated: false, redirect: location, title: null, text: '', url: url.toString() });
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '');
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`La página respondió con HTTP ${status}.`));
          return;
        }
        if (!TEXT_TYPES.test(contentType)) {
          response.resume();
          reject(new Error(`La página no es texto (${contentType || 'tipo desconocido'}).`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = (): void => resolve({ status, contentType, html: Buffer.concat(chunks).toString('utf8'), truncated, redirect: null, title: null, text: '', url: url.toString() });
        response.on('end', done);
        response.on('close', done);
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('La página tardó demasiado en responder.'));
    });
    request.on('error', reject);
    const onAbort = (): void => {
      request.destroy(new Error('La descarga se canceló.'));
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€' };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m?.[1] === undefined ? '' : decode(m[1]).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title.slice(0, 200);
}

/** Readable text out of HTML: scripts, styles and tags removed, blocks on their own lines. */
export function extractText(html: string, contentType = 'text/html'): string {
  if (!/html|xml/i.test(contentType)) return html.replace(/\s+\n/g, '\n').trim();
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Real publishing, one adapter per platform. Each publishes ONLY when the person
 * taps the button for that piece (the tap is the approval); nothing here runs on a
 * timer or on the AI's own decision.
 *
 *  - Telegram: a bot posts to a channel or chat (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
 *  - Facebook: a Page access token posts to the Page (FACEBOOK_PAGE_ID + FACEBOOK_PAGE_TOKEN).
 *
 * Instagram and TikTok are not here: they need app review or a public media URL, so
 * they stay manual through the phone's share sheet.
 */

import { MediaError } from './media.ts';
import type { Media } from './store.ts';

export type PublishTarget = 'telegram' | 'facebook';

export interface PublishInput {
  caption: string;
  image: Media | null;
  audio: Media | null;
  video: Media | null;
}

export interface PublishResult {
  target: PublishTarget;
  /** What was sent: the video if there is one, else the picture, else the voice, else the text. */
  sent: 'video' | 'image' | 'audio' | 'text';
  id: string | null;
}

export interface Publisher {
  target: PublishTarget;
  label: string;
  publish(input: PublishInput): Promise<PublishResult>;
}

type PlainFetch = typeof fetch;

const blob = (m: Media) => new Blob([Buffer.from(m.base64, 'base64')], { type: m.mime });
const ext = (m: Media) => (m.mime.split('/')[1] ?? 'bin').replace('quicktime', 'mov').replace('mpeg', 'mp3');
const which = (i: PublishInput): PublishResult['sent'] => (i.video !== null ? 'video' : i.image !== null ? 'image' : i.audio !== null ? 'audio' : 'text');

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class TelegramPublisher implements Publisher {
  readonly target = 'telegram' as const;
  readonly label = 'Telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: PlainFetch = fetch,
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const sent = which(input);
    const form = new FormData();
    form.set('chat_id', this.chatId);
    let method = 'sendMessage';
    // Telegram captions are limited to 1024 characters; a longer text goes as its own message afterwards.
    const long = input.caption.length > 1024;
    if (sent === 'video' && input.video !== null) {
      method = 'sendVideo';
      form.set('video', blob(input.video), `video.${ext(input.video)}`);
      form.set('supports_streaming', 'true');
    } else if (sent === 'image' && input.image !== null) {
      method = 'sendPhoto';
      form.set('photo', blob(input.image), `image.${ext(input.image)}`);
    } else if (sent === 'audio' && input.audio !== null) {
      method = 'sendAudio';
      form.set('audio', blob(input.audio), `voice.${ext(input.audio)}`);
    } else form.set('text', input.caption.slice(0, 4096));
    if (sent !== 'text' && !long && input.caption !== '') form.set('caption', input.caption);

    const first = await this.call(method, form);
    if (sent !== 'text' && long) {
      const more = new FormData();
      more.set('chat_id', this.chatId);
      more.set('text', input.caption.slice(0, 4096));
      await this.call('sendMessage', more);
    }
    return { target: this.target, sent, id: first };
  }

  private async call(method: string, form: FormData): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      // The token is part of the URL, so the raw network error is never shown.
      throw new MediaError(`No se pudo conectar con Telegram${error instanceof Error && error.name === 'TimeoutError' ? ' (tardó demasiado)' : ''}.`);
    }
    const data = await readJson(response);
    if (response.status === 401 || response.status === 404) throw new MediaError('Telegram rechazó el bot. Revisa TELEGRAM_BOT_TOKEN.', 502);
    if (!response.ok || data['ok'] !== true) {
      const detail = typeof data['description'] === 'string' ? data['description'] : `error ${response.status}`;
      throw new MediaError(`Telegram no publicó: ${detail}. ${/chat not found|not enough rights|kicked/i.test(detail) ? 'Comprueba TELEGRAM_CHAT_ID y que el bot es administrador del canal.' : ''}`.trim());
    }
    const id = (data['result'] as { message_id?: number } | undefined)?.message_id;
    return id === undefined ? null : String(id);
  }
}

export class FacebookPublisher implements Publisher {
  readonly target = 'facebook' as const;
  readonly label = 'Facebook (página)';

  constructor(
    private readonly pageId: string,
    private readonly pageToken: string,
    private readonly fetchImpl: PlainFetch = fetch,
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const sent = which(input);
    const form = new FormData();
    form.set('access_token', this.pageToken);
    let url = `https://graph.facebook.com/v21.0/${encodeURIComponent(this.pageId)}/feed`;
    if (sent === 'video' && input.video !== null) {
      url = `https://graph-video.facebook.com/v21.0/${encodeURIComponent(this.pageId)}/videos`;
      form.set('source', blob(input.video), `video.${ext(input.video)}`);
      form.set('description', input.caption);
    } else if (sent === 'image' && input.image !== null) {
      url = `https://graph.facebook.com/v21.0/${encodeURIComponent(this.pageId)}/photos`;
      form.set('source', blob(input.image), `image.${ext(input.image)}`);
      form.set('caption', input.caption);
    } else form.set('message', input.caption || 'Nueva publicación');

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) });
    } catch (error) {
      throw new MediaError(`No se pudo conectar con Facebook${error instanceof Error && error.name === 'TimeoutError' ? ' (tardó demasiado)' : ''}.`);
    }
    const data = await readJson(response);
    if (!response.ok) {
      const err = data['error'] as { message?: string; code?: number } | undefined;
      if (err?.code === 190 || response.status === 401) throw new MediaError('Facebook rechazó el token de la página (FACEBOOK_PAGE_TOKEN). Puede haber caducado.', 502);
      throw new MediaError(`Facebook no publicó: ${(err?.message ?? `error ${response.status}`).slice(0, 200)}`);
    }
    const id = data['post_id'] ?? data['id'];
    return { target: this.target, sent, id: typeof id === 'string' ? id : null };
  }
}

export function buildPublishers(options: { telegramToken?: string | undefined; telegramChatId?: string | undefined; facebookPageId?: string | undefined; facebookPageToken?: string | undefined }): Publisher[] {
  return [
    ...(options.telegramToken !== undefined && options.telegramChatId !== undefined ? [new TelegramPublisher(options.telegramToken, options.telegramChatId)] : []),
    ...(options.facebookPageId !== undefined && options.facebookPageToken !== undefined ? [new FacebookPublisher(options.facebookPageId, options.facebookPageToken)] : []),
  ];
}

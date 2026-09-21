-- Content calendar: posts prepared by the person (text, image, voice-over) with a
-- date to publish them. Media is kept in the row (base64) so no extra storage
-- service is needed; listings never select those columns.
CREATE TABLE IF NOT EXISTS content_items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text        NOT NULL,
  caption       text        NOT NULL DEFAULT '',
  platform      text        NOT NULL DEFAULT 'instagram',
  status        text        NOT NULL DEFAULT 'draft',
  scheduled_at  timestamptz,
  published_at  timestamptz,
  image_prompt  text        NOT NULL DEFAULT '',
  voice_text    text        NOT NULL DEFAULT '',
  image_mime    text,
  image_b64     text,
  audio_mime    text,
  audio_b64     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_items_status_valid CHECK (status IN ('draft', 'scheduled', 'published'))
);

CREATE INDEX IF NOT EXISTS content_items_schedule_idx ON content_items (status, scheduled_at);

-- Content calendar: a finished vertical video per item (mp4, base64, like the other media).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS video_mime text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS video_b64  text;

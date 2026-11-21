-- Turn on the Go Sanchari Meta Pixel (PageView on public pages, Lead on enquiry success,
-- BookNow on quote acceptance). Only fills in a pixel when an admin has not set one yet.
INSERT INTO settings (key, value)
VALUES ('meta_pixel', '{"enabled":true,"pixel_id":"1373267341618684","lead":true,"book_now":true}')
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE COALESCE(json_extract(settings.value, '$.pixel_id'), '') = '';

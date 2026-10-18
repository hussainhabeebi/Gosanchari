-- New official Instagram page. Saved business settings override the code default, so update them too.
UPDATE settings
SET value = json_set(value, '$.social.instagram', 'https://www.instagram.com/gosanchari.official'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key = 'business' AND json_valid(value);

-- AI photo insights (Gemini): suggested section, alt text and cover score per photo.
-- auto_sort = 1 for photos whose section nobody chose (imported from a resort website): AI may move them.
ALTER TABLE property_photos ADD COLUMN ai_category TEXT;
ALTER TABLE property_photos ADD COLUMN ai_caption TEXT;
ALTER TABLE property_photos ADD COLUMN ai_score INTEGER;
ALTER TABLE property_photos ADD COLUMN auto_sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE property_photos ADD COLUMN source_url TEXT;

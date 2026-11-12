-- Property SEO: a staff-written public description (up to 2,000 characters, shown on the stay page as "About this
-- property"), per-property FAQs (JSON array of {"q","a"}) and optional image alt text.
-- The older properties.description column is NOT shown publicly (it holds legacy generated text) and is untouched.
-- Additive only. Existing rows get '[]' / NULL and keep working; the stay page falls back to caption / name for alt text.
-- seo_title / seo_description already exist on properties (0001) and are reused.
ALTER TABLE properties ADD COLUMN public_description TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN faqs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE property_photos ADD COLUMN alt_text TEXT;

-- Manual rollback for migrations 0028 and 0029. NOT in migrations/, so it is never applied automatically.
-- Run only after deploying code that no longer uses these columns/tables, and after exporting any data to keep:
--   npx wrangler d1 export gosanchari --remote --output backup.sql
-- Removes blog posts, slug redirects, property public descriptions, FAQs and image alt text. Featured images stay in R2 under blog/.
DROP TABLE IF EXISTS blog_slug_redirects;
DROP TABLE IF EXISTS blog_posts;
ALTER TABLE property_photos DROP COLUMN alt_text;
ALTER TABLE properties DROP COLUMN faqs;
ALTER TABLE properties DROP COLUMN public_description;
-- Then remove the two rows from the d1_migrations table so they could be re-applied later:
-- DELETE FROM d1_migrations WHERE name IN ('0028_property_seo.sql', '0029_blog.sql');

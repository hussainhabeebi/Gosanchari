-- Blog posts managed in Admin → Website Settings → Blog, shown at /blog and /blog/:slug.
-- content_html is stored already sanitized (src/lib/sanitize.ts) and is sanitized again when shown.
-- published_at is the publication date (YYYY-MM-DD, India time). A published post is public from that date.
CREATE TABLE blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  meta_title TEXT,
  meta_description TEXT,
  featured_image_key TEXT,
  featured_image_alt TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  published_at TEXT,
  first_published_at TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_blog_public ON blog_posts(status, published_at);

-- Old slugs of posts that had been published, so shared links keep working (301 to the current slug).
CREATE TABLE blog_slug_redirects (
  old_slug TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_blog_redirect_post ON blog_slug_redirects(post_id);

-- Additive only. Existing bookings, booking invitations and reviews are unchanged.
CREATE TABLE property_review_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_property_review_links_owner ON property_review_links(created_by, id);
ALTER TABLE reviews ADD COLUMN property_review_link_id INTEGER REFERENCES property_review_links(id);
CREATE UNIQUE INDEX idx_reviews_property_invite ON reviews(property_review_link_id) WHERE property_review_link_id IS NOT NULL;
-- These audits commit atomically with invitation changes and guest submission.
CREATE TRIGGER property_review_link_created AFTER INSERT ON property_review_links BEGIN
  INSERT INTO activity_log(user_id,action,entity,entity_id,details)
    VALUES(NEW.created_by,'property_review_link.issued','property_review_link',CAST(NEW.id AS TEXT),json_object('property_id',NEW.property_id));
END;
CREATE TRIGGER property_review_link_revoked AFTER UPDATE OF revoked_at ON property_review_links
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN
  INSERT INTO activity_log(user_id,action,entity,entity_id,details)
    VALUES(NEW.revoked_by,'property_review_link.revoked','property_review_link',CAST(NEW.id AS TEXT),json_object('property_id',NEW.property_id));
END;
CREATE TRIGGER property_review_link_submitted AFTER INSERT ON reviews
WHEN NEW.property_review_link_id IS NOT NULL BEGIN
  INSERT INTO activity_log(user_id,action,entity,entity_id,details)
    VALUES(NULL,'property_review_link.submitted','review',CAST(NEW.id AS TEXT),json_object('link_id',NEW.property_review_link_id,'property_id',NEW.property_id));
END;

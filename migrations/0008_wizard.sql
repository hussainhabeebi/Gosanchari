-- Property wizard (admin "Add Property" in 7 steps).
-- Rates per meal plan: each season/period row can be for one meal plan (CP / MAP / AP / EP); NULL = any plan.
ALTER TABLE season_rates ADD COLUMN meal_plan TEXT;
-- Rows written by the wizard's Room Rates step (so re-saving a room replaces only those).
ALTER TABLE season_rates ADD COLUMN source TEXT;
-- Lists the data-entry team can extend from the admin ("+ Add New Category / Facility / Amenity / Room Category / Activity").
CREATE TABLE IF NOT EXISTS taxonomy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- property_type | theme | facility | activity | amenity | room_category
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  icon TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,  -- 1 = built-in item hidden from the lists
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (kind, key)
);

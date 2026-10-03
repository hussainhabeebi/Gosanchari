-- Richer property details: more property types, location link, dining, policies, contact & direct booking,
-- photo/video sections, and room-category details.

-- 1. Property details. New stay types go in `stay_type`; the original `type` column keeps the nearest
--    basic category (its CHECK constraint can't be changed without rebuilding a table that bookings reference).
ALTER TABLE properties ADD COLUMN stay_type TEXT;                          -- villa, cottage, resort, hotel, treehouse, glamping…
ALTER TABLE properties ADD COLUMN map_url TEXT;                            -- Google Maps link
ALTER TABLE properties ADD COLUMN star_category INTEGER;                   -- 1–5 (optional)
ALTER TABLE properties ADD COLUMN built_year INTEGER;
ALTER TABLE properties ADD COLUMN themes TEXT NOT NULL DEFAULT '[]';       -- honeymoon, family, budget, luxury, workcation…
ALTER TABLE properties ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';    -- languages spoken by hosts/staff
ALTER TABLE properties ADD COLUMN how_to_reach TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN best_time TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN good_to_know TEXT NOT NULL DEFAULT '';   -- public notes ("steep road", "no lift")
ALTER TABLE properties ADD COLUMN dining TEXT NOT NULL DEFAULT '{}';       -- restaurant, cuisines, timings, menu types, meal-plan prices
ALTER TABLE properties ADD COLUMN policies TEXT NOT NULL DEFAULT '{}';     -- pet, child, extra bed, smoking, alcohol, couples, ID, visitors…
ALTER TABLE properties ADD COLUMN contact TEXT NOT NULL DEFAULT '{}';      -- property contact + direct booking link (staff only)
UPDATE properties SET stay_type = type;

-- 2. Photos & videos in sections. category: common, facade, room, pool, view, restaurant, activities, other.
ALTER TABLE property_photos ADD COLUMN category TEXT NOT NULL DEFAULT 'common';
ALTER TABLE property_photos ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE property_photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'; -- image | video
ALTER TABLE property_photos ADD COLUMN video_url TEXT;                             -- YouTube / Vimeo link
CREATE INDEX idx_photos_category ON property_photos(property_id, category, sort);

-- 3. Room categories: more detail.
ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN size_sqft INTEGER;
ALTER TABLE rooms ADD COLUMN room_view TEXT;
ALTER TABLE rooms ADD COLUMN max_adults INTEGER;
ALTER TABLE rooms ADD COLUMN max_children INTEGER;
ALTER TABLE rooms ADD COLUMN extra_bed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN extra_bed_rate INTEGER;

-- Nullable supplied details. Copy/drop/rename changes no primary keys or foreign keys;
-- preserve the legacy defaults for other properties and permit explicit NULL for catalogues.
ALTER TABLE rooms ADD COLUMN supplied_capacity INTEGER DEFAULT 2;
UPDATE rooms SET supplied_capacity = capacity;
ALTER TABLE rooms DROP COLUMN capacity;
ALTER TABLE rooms RENAME COLUMN supplied_capacity TO capacity;
ALTER TABLE rooms ADD COLUMN supplied_min_nights INTEGER DEFAULT 1;
UPDATE rooms SET supplied_min_nights = min_nights;
ALTER TABLE rooms DROP COLUMN min_nights;
ALTER TABLE rooms RENAME COLUMN supplied_min_nights TO min_nights;
ALTER TABLE rooms ADD COLUMN supplied_extra_bed INTEGER DEFAULT 0;
UPDATE rooms SET supplied_extra_bed = extra_bed;
ALTER TABLE rooms DROP COLUMN extra_bed;
ALTER TABLE rooms RENAME COLUMN supplied_extra_bed TO extra_bed;
ALTER TABLE properties ADD COLUMN supplied_checkin_time TEXT DEFAULT '14:00';
UPDATE properties SET supplied_checkin_time = checkin_time;
ALTER TABLE properties DROP COLUMN checkin_time;
ALTER TABLE properties RENAME COLUMN supplied_checkin_time TO checkin_time;
ALTER TABLE properties ADD COLUMN supplied_checkout_time TEXT DEFAULT '11:00';
UPDATE properties SET supplied_checkout_time = checkout_time;
ALTER TABLE properties DROP COLUMN checkout_time;
ALTER TABLE properties RENAME COLUMN supplied_checkout_time TO checkout_time;
ALTER TABLE properties ADD COLUMN supplied_id_required INTEGER DEFAULT 1;
UPDATE properties SET supplied_id_required = id_required;
ALTER TABLE properties DROP COLUMN id_required;
ALTER TABLE properties RENAME COLUMN supplied_id_required TO id_required;
ALTER TABLE properties ADD COLUMN supplied_pet_friendly INTEGER DEFAULT 0;
UPDATE properties SET supplied_pet_friendly = pet_friendly;
ALTER TABLE properties DROP COLUMN pet_friendly;
ALTER TABLE properties RENAME COLUMN supplied_pet_friendly TO pet_friendly;
ALTER TABLE properties ADD COLUMN supplied_family_friendly INTEGER DEFAULT 1;
UPDATE properties SET supplied_family_friendly = family_friendly;
ALTER TABLE properties DROP COLUMN family_friendly;
ALTER TABLE properties RENAME COLUMN supplied_family_friendly TO family_friendly;
ALTER TABLE properties ADD COLUMN catalogue_only INTEGER NOT NULL DEFAULT 0 CHECK (catalogue_only IN (0,1));
ALTER TABLE properties ADD COLUMN classification TEXT;
ALTER TABLE rooms ADD COLUMN rack_basis TEXT;

-- Separate catalogue tariff periods from the quote engine: no markup, global season,
-- weekend, occupancy, GST or other-tier fallback is applied to these supplied figures.
CREATE TABLE catalogue_rate_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  staff_rate INTEGER CHECK (staff_rate IS NULL OR staff_rate >= 0),
  net_rate INTEGER CHECK (net_rate IS NULL OR net_rate >= 0),
  staff_basis TEXT,
  net_basis TEXT,
  CHECK (start_date <= end_date),
  UNIQUE(room_id, start_date, end_date)
);
CREATE TABLE property_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  charge_key TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  child_amount INTEGER CHECK (child_amount IS NULL OR child_amount >= 0),
  basis TEXT, -- NULL = not supplied; never silently assume per stay/night
  rate_basis TEXT, -- CPAI where explicitly supplied
  start_date TEXT,
  end_date TEXT,
  mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0,1)),
  options TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  CHECK ((start_date IS NULL AND end_date IS NULL) OR
         (start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= end_date)),
  UNIQUE(property_id, charge_key)
);

-- Defence in depth: catalogue rates never enter legacy quote/payment tables or
-- legacy room fields that older exports/AI queries can read.
CREATE TRIGGER catalogue_quote_insert BEFORE INSERT ON quotation_options
WHEN EXISTS (SELECT 1 FROM properties WHERE catalogue_only=1 AND (id=NEW.property_id OR id=(SELECT property_id FROM rooms WHERE id=NEW.room_id)))
BEGIN SELECT RAISE(ABORT, 'Catalogue property cannot be quoted/booked'); END;
CREATE TRIGGER catalogue_quote_update BEFORE UPDATE ON quotation_options
WHEN EXISTS (SELECT 1 FROM properties WHERE catalogue_only=1 AND (id=NEW.property_id OR id=(SELECT property_id FROM rooms WHERE id=NEW.room_id)))
BEGIN SELECT RAISE(ABORT, 'Catalogue property cannot be quoted/booked'); END;
CREATE TRIGGER catalogue_booking_insert BEFORE INSERT ON bookings
WHEN EXISTS (SELECT 1 FROM properties WHERE catalogue_only=1 AND (id=NEW.property_id OR id=(SELECT property_id FROM rooms WHERE id=NEW.room_id)))
BEGIN SELECT RAISE(ABORT, 'Catalogue property cannot be booked'); END;
CREATE TRIGGER catalogue_booking_update BEFORE UPDATE ON bookings
WHEN EXISTS (SELECT 1 FROM properties WHERE catalogue_only=1 AND (id=NEW.property_id OR id=(SELECT property_id FROM rooms WHERE id=NEW.room_id)))
BEGIN SELECT RAISE(ABORT, 'Catalogue property cannot be booked'); END;
CREATE TRIGGER catalogue_room_insert BEFORE INSERT ON rooms
WHEN (NEW.staff_rate IS NOT NULL OR NEW.net_rate IS NOT NULL)
AND EXISTS (SELECT 1 FROM properties WHERE id=NEW.property_id AND catalogue_only=1)
BEGIN SELECT RAISE(ABORT, 'Use role-projected catalogue rate periods'); END;
CREATE TRIGGER catalogue_room_update BEFORE UPDATE ON rooms
WHEN (NEW.staff_rate IS NOT NULL OR NEW.net_rate IS NOT NULL)
AND EXISTS (SELECT 1 FROM properties WHERE id=NEW.property_id AND catalogue_only=1)
BEGIN SELECT RAISE(ABORT, 'Use role-projected catalogue rate periods'); END;

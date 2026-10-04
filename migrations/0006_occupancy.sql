-- Occupancy-based pricing per room category:
--   base_guests      = guests included in the room rate (e.g. 2, or 8 for a large cottage); NULL = same as capacity
--   capacity         = maximum guests (already existed)
--   extra_adult_rate = charge per extra adult per night above base_guests
--   extra_child_rate = charge per extra child per night (NULL = same as adult)
ALTER TABLE rooms ADD COLUMN base_guests INTEGER;
ALTER TABLE rooms ADD COLUMN extra_adult_rate INTEGER;
ALTER TABLE rooms ADD COLUMN extra_child_rate INTEGER;
-- The old "extra bed" charge becomes the extra-adult charge.
UPDATE rooms SET extra_adult_rate = extra_bed_rate WHERE extra_bed = 1 AND extra_bed_rate IS NOT NULL;

-- Explicit GST choice; existing amounts are preserved and existing behavior defaults ON.
ALTER TABLE quotations ADD COLUMN apply_gst INTEGER NOT NULL DEFAULT 1 CHECK (apply_gst IN (0, 1));
ALTER TABLE bookings ADD COLUMN apply_gst INTEGER NOT NULL DEFAULT 1 CHECK (apply_gst IN (0, 1));

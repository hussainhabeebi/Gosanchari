-- Speeds up Staff Property Finder and public search.
-- Location in this schema is properties.destination (town/area) + properties.address; there is no separate city column.
-- Name lookups: case-insensitive, live properties first (also serves "starts with" keyword matches).
CREATE INDEX IF NOT EXISTS idx_properties_status_name ON properties(status, name COLLATE NOCASE);
-- Status-first listing, filtered by location.
CREATE INDEX IF NOT EXISTS idx_properties_status_dest ON properties(status, destination COLLATE NOCASE);
-- Per-property room lookups always filter on active rooms.
CREATE INDEX IF NOT EXISTS idx_rooms_property_active ON rooms(property_id, active);
-- Pricing loads a property's seasons for specific rooms.
CREATE INDEX IF NOT EXISTS idx_season_property_room ON season_rates(property_id, room_id);

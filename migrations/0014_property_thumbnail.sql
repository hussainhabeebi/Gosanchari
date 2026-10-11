-- A chosen thumbnail per property: the main image on the website (search cards, home page, stay page) and in the panel.
-- NULL = automatic (exterior photo first, as before). Additive only.
ALTER TABLE properties ADD COLUMN thumbnail_photo_id INTEGER;

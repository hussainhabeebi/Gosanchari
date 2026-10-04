-- Detailed B2B contracts (as resorts send them):
-- rooms: rack (published) rate, B2B net versions of the extra-person charges, child without bed.
ALTER TABLE rooms ADD COLUMN rack_rate INTEGER;
ALTER TABLE rooms ADD COLUMN net_extra_adult_rate INTEGER;
ALTER TABLE rooms ADD COLUMN net_extra_child_rate INTEGER;
ALTER TABLE rooms ADD COLUMN child_no_bed_rate INTEGER;
ALTER TABLE rooms ADD COLUMN net_child_no_bed_rate INTEGER;
-- seasons / rate periods: separate weekend rates, and flat supplements added on top (e.g. X'mas +₹1,000/room/night).
ALTER TABLE season_rates ADD COLUMN weekend_rate INTEGER;
ALTER TABLE season_rates ADD COLUMN staff_weekend_rate INTEGER;
ALTER TABLE season_rates ADD COLUMN net_weekend_rate INTEGER;
ALTER TABLE season_rates ADD COLUMN supplement INTEGER;
ALTER TABLE season_rates ADD COLUMN net_supplement INTEGER;
-- properties: which nights are "weekend" (JS weekday numbers of the night: 5 = Fri, 6 = Sat, 0 = Sun),
-- meal plan the rates include, child age band, add-ons (campfire, candle-light dinner…), contract validity and terms.
ALTER TABLE properties ADD COLUMN weekend_nights TEXT NOT NULL DEFAULT '5,6';
ALTER TABLE properties ADD COLUMN rate_meal_plan TEXT;
ALTER TABLE properties ADD COLUMN child_free_below INTEGER;
ALTER TABLE properties ADD COLUMN child_age_to INTEGER;
ALTER TABLE properties ADD COLUMN addons TEXT NOT NULL DEFAULT '[]';
ALTER TABLE properties ADD COLUMN b2b_valid_from TEXT;
ALTER TABLE properties ADD COLUMN b2b_valid_to TEXT;
ALTER TABLE properties ADD COLUMN b2b_terms TEXT NOT NULL DEFAULT '';
-- quotes: add-ons chosen for an option, e.g. [{"name":"Campfire","price":1800,"qty":1}]
ALTER TABLE quotation_options ADD COLUMN addons TEXT NOT NULL DEFAULT '[]';

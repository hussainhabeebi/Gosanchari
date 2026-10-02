-- Go Sanchari core schema (Cloudflare D1 / SQLite)
-- Money is stored in whole rupees (INTEGER). Dates are ISO strings: YYYY-MM-DD for stay dates,
-- full ISO timestamps for created_at / updated_at.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest','admin','manager','sales','accounts')),
  name TEXT NOT NULL DEFAULT '',
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ml')),
  whatsapp_updates INTEGER NOT NULL DEFAULT 1,
  photo_key TEXT,
  notify_settings TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,
  merged_into INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE travellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age INTEGER,
  relation TEXT
);

CREATE TABLE staff_destinations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  PRIMARY KEY (user_id, destination)
);

CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  image TEXT,
  blurb TEXT,
  popular INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('homestay','villa','resort','houseboat','cottage')),
  destination TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  owner_name TEXT,
  owner_phone TEXT,
  owner_email TEXT,
  is_partner INTEGER NOT NULL DEFAULT 0,
  commission_pct REAL NOT NULL DEFAULT 0,
  highlights TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  description_ml TEXT NOT NULL DEFAULT '',
  facilities TEXT NOT NULL DEFAULT '[]',
  meal_plans TEXT NOT NULL DEFAULT '[]',
  checkin_time TEXT NOT NULL DEFAULT '14:00',
  checkout_time TEXT NOT NULL DEFAULT '11:00',
  cancellation_policy TEXT NOT NULL DEFAULT '',
  house_rules TEXT NOT NULL DEFAULT '',
  id_required INTEGER NOT NULL DEFAULT 1,
  nearby TEXT NOT NULL DEFAULT '[]',
  pet_friendly INTEGER NOT NULL DEFAULT 0,
  family_friendly INTEGER NOT NULL DEFAULT 1,
  internal_notes TEXT NOT NULL DEFAULT '',
  last_minute_note TEXT NOT NULL DEFAULT '',
  seo_title TEXT,
  seo_description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','hidden')),
  featured INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  review_summary TEXT,
  review_summary_at TEXT,
  embedded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_properties_dest ON properties(destination, status);

CREATE TABLE property_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  caption TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  ai_tags TEXT NOT NULL DEFAULT '[]',
  tags_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_photos_property ON property_photos(property_id, sort);

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 2,
  bed_type TEXT,
  facilities TEXT NOT NULL DEFAULT '[]',
  inclusions TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL DEFAULT 1,
  base_rate INTEGER NOT NULL,
  weekend_rate INTEGER,
  net_rate INTEGER,
  min_nights INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_rooms_property ON rooms(property_id);

-- Season / special rates. room_id NULL = applies to all rooms in the property.
-- Either a fixed nightly rate or a percentage adjustment on the base/weekend rate.
CREATE TABLE season_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  rate INTEGER,
  pct_adjust REAL,
  min_nights INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_season_property ON season_rates(property_id, start_date);

-- Blocked or held room-nights. quotation_id set = a temporary hold for a quote.
CREATE TABLE blocked_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  reason TEXT,
  quotation_id INTEGER,
  hold_until TEXT,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_blocked ON blocked_dates(property_id, date);

CREATE TABLE coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL CHECK (discount_type IN ('pct','flat')),
  discount_value REAL NOT NULL,
  max_discount INTEGER,
  min_amount INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  property_ids TEXT, -- JSON array, NULL = all properties
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  guest_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  destination TEXT,
  property_id INTEGER REFERENCES properties(id),
  check_in TEXT,
  check_out TEXT,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  budget INTEGER,
  message TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'website' CHECK (source IN ('website','whatsapp','phone','instagram','chat','email')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','quoted','booked','closed','lost')),
  lost_reason TEXT,
  assigned_to INTEGER REFERENCES users(id),
  tags TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  summary TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  whatsapp_optin INTEGER NOT NULL DEFAULT 0,
  waiting_on TEXT NOT NULL DEFAULT 'us' CHECK (waiting_on IN ('us','guest')),
  chat_room TEXT,
  last_guest_msg_at TEXT,
  last_staff_reply_at TEXT,
  first_response_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_enq_status ON enquiries(status, assigned_to);
CREATE INDEX idx_enq_phone ON enquiries(phone);
CREATE INDEX idx_enq_user ON enquiries(user_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('guest','staff','ai','system')),
  user_id INTEGER REFERENCES users(id),
  channel TEXT NOT NULL DEFAULT 'website' CHECK (channel IN ('website','whatsapp','email','note','chat')),
  body TEXT NOT NULL DEFAULT '',
  media_key TEXT,
  media_type TEXT,
  transcript TEXT,
  translation TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_msg_enq ON messages(enquiry_id, created_at);
CREATE INDEX idx_msg_booking ON messages(booking_id, created_at);

CREATE TABLE quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  enquiry_id INTEGER REFERENCES enquiries(id),
  user_id INTEGER REFERENCES users(id),
  staff_id INTEGER REFERENCES users(id),
  guest_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','sent','viewed','accepted','expired','declined','changes_requested')),
  valid_till TEXT,
  inclusions TEXT NOT NULL DEFAULT '',
  exclusions TEXT NOT NULL DEFAULT '',
  payment_terms TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  explainer TEXT,
  guest_feedback TEXT,
  accepted_option_id INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_quote_status ON quotations(status, staff_id);

CREATE TABLE quotation_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  rooms_count INTEGER NOT NULL DEFAULT 1,
  meal_plan TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  extra_charges INTEGER NOT NULL DEFAULT 0,
  extra_label TEXT,
  taxes INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  discount_approved_by INTEGER REFERENCES users(id)
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  rooms_count INTEGER NOT NULL DEFAULT 1,
  meal_plan TEXT,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  extra_charges INTEGER NOT NULL DEFAULT 0,
  taxes INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','checked_in','completed','cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','failed','refunded','partially_refunded')),
  source TEXT NOT NULL DEFAULT 'website',
  guest_name TEXT NOT NULL,
  guest_phone TEXT NOT NULL,
  guest_email TEXT,
  id_type TEXT,
  special_requests TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  quotation_id INTEGER REFERENCES quotations(id),
  enquiry_id INTEGER REFERENCES enquiries(id),
  staff_id INTEGER REFERENCES users(id),
  change_request TEXT,
  change_status TEXT CHECK (change_status IN ('requested','approved','rejected')),
  invoice_key TEXT,
  reminder_sent_at TEXT,
  hold_expires_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_book_dates ON bookings(property_id, room_id, check_in, check_out);
CREATE INDEX idx_book_user ON bookings(user_id);
CREATE INDEX idx_book_status ON bookings(status, check_in);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
  gateway TEXT NOT NULL DEFAULT 'manual', -- payment method: upi, bank_transfer, cash, card, other
  gateway_order_id TEXT UNIQUE,
  gateway_payment_id TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pay_booking ON payments(booking_id);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  payment_id INTEGER REFERENCES payments(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','processed','failed')),
  gateway_refund_id TEXT,
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  booking_id INTEGER REFERENCES bookings(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  reference TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER UNIQUE REFERENCES bookings(id),
  user_id INTEGER REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  guest_name TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  photos TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  reply TEXT,
  reply_draft TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reviews_property ON reviews(property_id, status);

CREATE TABLE wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  saved_price INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assigned_to INTEGER REFERENCES users(id),
  guest_user_id INTEGER REFERENCES users(id),
  enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE CASCADE,
  quotation_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  guest_name TEXT,
  phone TEXT,
  reason TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  draft_message TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tasks_due ON tasks(status, assigned_to, due_at);

-- Guest preference notes (from AI extraction or staff); editable.
CREATE TABLE guest_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  note TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','preference')),
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('ai','staff')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notes_user ON guest_notes(user_id);
CREATE INDEX idx_notes_phone ON guest_notes(phone);

-- Website content blocks (banners, FAQs, policies, about, why-us) as JSON values.
CREATE TABLE content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity ON activity_log(created_at);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_usage ON ai_usage(created_at, feature);

-- Stored AI insights from scheduled jobs (daily summary, lost reasons, review problems).
CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_insights ON insights(kind, period);

-- Safe, secret-free views used by "Ask AI" (read-only business questions).
CREATE VIEW people AS
  SELECT id, role, name, phone, email, language, active, blocked, created_at FROM users WHERE merged_into IS NULL;

CREATE VIEW quotes AS
  SELECT id, code, enquiry_id, user_id, staff_id, guest_name, status, valid_till, view_count,
         last_viewed_at, sent_at, created_at,
         (SELECT MIN(total) FROM quotation_options o WHERE o.quotation_id = quotations.id) AS total
  FROM quotations;

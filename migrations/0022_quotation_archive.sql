-- Additive, no backfill/status rewrite or deletion of business records.
ALTER TABLE quotations ADD COLUMN archived_at TEXT;
ALTER TABLE quotations ADD COLUMN archived_by INTEGER REFERENCES users(id);
ALTER TABLE quotations ADD COLUMN archive_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN archive_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN restored_at TEXT;
ALTER TABLE quotations ADD COLUMN restored_by INTEGER REFERENCES users(id);
CREATE INDEX idx_quote_archive ON quotations(archived_at,staff_id,updated_at);
CREATE INDEX idx_archive_options ON quotation_options(quotation_id);
CREATE INDEX idx_archive_confirmations ON quotation_confirmation_requests(quotation_id,status);
CREATE INDEX idx_archive_holds ON blocked_dates(quotation_id,date);
CREATE INDEX idx_archive_refunds ON refunds(booking_id);
CREATE INDEX idx_archive_activity ON activity_log(entity,entity_id,action);

-- One shared eligibility rule for routes AND atomic archive/restore transitions.
-- Even cancelled bookings remain protected when they carry financial/voucher history.
CREATE VIEW quotation_archive_eligibility AS
SELECT q.id, CASE
 WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.quotation_id=q.id AND b.status!='cancelled') THEN 'This quotation has an active booking. Archiving will not cancel bookings.'
 WHEN EXISTS(SELECT 1 FROM quotation_options o WHERE o.quotation_id=q.id AND (o.reported_advance>0 OR EXISTS(SELECT 1 FROM json_each(o.advance_details) WHERE value IS NOT NULL AND CAST(value AS TEXT)!=''))) THEN 'Recorded advance or payment evidence must be retained. This quotation cannot be archived.'
 WHEN EXISTS(SELECT 1 FROM activity_log a WHERE a.entity='quotation' AND a.entity_id=CAST(q.id AS TEXT) AND a.action='quote.reported_advance' AND CASE WHEN json_valid(a.details) THEN COALESCE(json_extract(a.details,'$.to'),0)!=0 ELSE 1 END) THEN 'Previously reported advances remain financial evidence, even after an amount is cleared. This quotation cannot be archived.'
 WHEN EXISTS(SELECT 1 FROM quotation_confirmation_requests r WHERE (r.quotation_id=q.id OR r.option_id IN (SELECT id FROM quotation_options WHERE quotation_id=q.id)) AND (r.status IN ('pending','approved') OR COALESCE(json_extract(r.details,'$.paid'),0)!=0 OR COALESCE(json_extract(r.details,'$.reported_advance'),0)!=0 OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(r.details,'$.payment_details') IN ('object','array') THEN json_extract(r.details,'$.payment_details') ELSE json_object('evidence',json_extract(r.details,'$.payment_details')) END) WHERE value IS NOT NULL AND CAST(value AS TEXT)!=''))) THEN 'Booking-confirmation or payment-evidence history protects this quotation from archiving.'
 WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.quotation_id=q.id AND (b.amount_paid!=0 OR b.payment_status NOT IN ('unpaid','failed') OR EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=b.id) OR EXISTS(SELECT 1 FROM refunds r WHERE r.booking_id=b.id))) THEN 'This quotation has payment or refund history. It cannot be archived.'
 WHEN EXISTS(SELECT 1 FROM booking_vouchers v JOIN bookings b ON b.id=v.booking_id WHERE b.quotation_id=q.id AND (v.status IN ('pending','approved') OR CASE WHEN json_valid(v.snapshot) THEN COALESCE(json_extract(v.snapshot,'$.paid'),0)!=0 ELSE v.snapshot IS NOT NULL END)) THEN 'A booking voucher or its financial evidence protects this quotation from archiving.'
 WHEN EXISTS(SELECT 1 FROM blocked_dates d WHERE d.quotation_id=q.id AND d.date>=date('now') AND (d.hold_until IS NULL OR julianday(d.hold_until)>julianday('now'))) THEN 'Release the active room hold before archiving this quotation.'
 ELSE NULL END AS reason FROM quotations q;

CREATE TRIGGER quotation_archive_transition BEFORE UPDATE OF archived_at,archived_by,archive_reason,archive_revision,restored_at,restored_by ON quotations BEGIN
 SELECT CASE WHEN NOT ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND NEW.archived_by IS NOT NULL AND NEW.restored_at IS NULL AND NEW.restored_by IS NULL) OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL AND NEW.archived_by IS NULL AND NEW.restored_at IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=NEW.restored_by AND role='admin' AND active=1 AND blocked=0))) THEN RAISE(ABORT,'Invalid archive transition or Admin restore permission') END;
 SELECT CASE WHEN NEW.archive_revision!=OLD.archive_revision+1 THEN RAISE(ABORT,'Stale archive revision') END;
 SELECT CASE WHEN (SELECT reason FROM quotation_archive_eligibility WHERE id=OLD.id) IS NOT NULL THEN RAISE(ABORT,'Quotation has protected booking, payment, evidence or hold dependencies') END;
END;
CREATE TRIGGER quotation_archive_audit AFTER UPDATE OF archived_at ON quotations BEGIN
 INSERT INTO activity_log(user_id,action,entity,entity_id,details)
 VALUES(CASE WHEN NEW.archived_at IS NULL THEN NEW.restored_by ELSE NEW.archived_by END,CASE WHEN NEW.archived_at IS NULL THEN 'quote.restored' ELSE 'quote.archived' END,'quotation',CAST(NEW.id AS TEXT),json_object('reason',CASE WHEN NEW.archived_at IS NULL THEN OLD.archive_reason ELSE NEW.archive_reason END,'revision',NEW.archive_revision,'at',COALESCE(NEW.archived_at,NEW.restored_at)));
END;
-- Prevent stale forms/queued jobs from editing or issuing an archived offer.
CREATE TRIGGER quotation_archive_readonly BEFORE UPDATE OF status,guest_name,phone,email,valid_till,inclusions,exclusions,payment_terms,message,explainer,guest_feedback,accepted_option_id,view_count,last_viewed_at,sent_at,apply_gst ON quotations WHEN OLD.archived_at IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Archived quotation is read-only');
END;
CREATE TRIGGER quotation_archive_keep BEFORE DELETE ON quotations WHEN OLD.archived_at IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Archived quotations must be retained for audit');
END;
CREATE TRIGGER archive_guard_quotation_options_insert BEFORE INSERT ON quotation_options WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_quotation_options_update BEFORE UPDATE ON quotation_options WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotations WHERE id=OLD.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_quotation_confirmation_requests_insert BEFORE INSERT ON quotation_confirmation_requests WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotation_options o JOIN quotations q ON q.id=o.quotation_id WHERE o.id=NEW.option_id AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_quotation_confirmation_requests_update BEFORE UPDATE ON quotation_confirmation_requests WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotations WHERE id=OLD.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotation_options o JOIN quotations q ON q.id=o.quotation_id WHERE o.id=NEW.option_id AND q.archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotation_options o JOIN quotations q ON q.id=o.quotation_id WHERE o.id=OLD.option_id AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_bookings_insert BEFORE INSERT ON bookings WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_bookings_update BEFORE UPDATE ON bookings WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotations WHERE id=OLD.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_blocked_dates_insert BEFORE INSERT ON blocked_dates WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_blocked_dates_update BEFORE UPDATE ON blocked_dates WHEN EXISTS(SELECT 1 FROM quotations WHERE id=NEW.quotation_id AND archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM quotations WHERE id=OLD.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation cannot receive changes or dependencies'); END;
CREATE TRIGGER archive_guard_option_delete BEFORE DELETE ON quotation_options WHEN EXISTS(SELECT 1 FROM quotations WHERE id=OLD.quotation_id AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Archived quotation options must be retained'); END;
CREATE TRIGGER archive_guard_payments_insert BEFORE INSERT ON payments WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;
CREATE TRIGGER archive_guard_payments_update BEFORE UPDATE ON payments WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id,OLD.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;
CREATE TRIGGER archive_guard_refunds_insert BEFORE INSERT ON refunds WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;
CREATE TRIGGER archive_guard_refunds_update BEFORE UPDATE ON refunds WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id,OLD.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;
CREATE TRIGGER archive_guard_booking_vouchers_insert BEFORE INSERT ON booking_vouchers WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;
CREATE TRIGGER archive_guard_booking_vouchers_update BEFORE UPDATE ON booking_vouchers WHEN EXISTS(SELECT 1 FROM bookings b JOIN quotations q ON q.id=b.quotation_id WHERE b.id IN (NEW.booking_id,OLD.booking_id) AND q.archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Restore the quotation before adding financial or voucher records'); END;

CREATE TRIGGER quotation_archive_new_active BEFORE INSERT ON quotations WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'New quotations must start active'); END;
CREATE TRIGGER quotation_archive_audit_keep BEFORE DELETE ON activity_log WHEN OLD.action IN ('quote.archived','quote.restored') BEGIN SELECT RAISE(ABORT,'Archive audit must be retained'); END;
CREATE TRIGGER quotation_archive_audit_readonly BEFORE UPDATE ON activity_log WHEN OLD.action IN ('quote.archived','quote.restored') BEGIN SELECT RAISE(ABORT,'Archive audit is immutable'); END;

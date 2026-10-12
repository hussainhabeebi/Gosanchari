-- Separate quotation approval records. No booking/payment/inventory writes or historical backfill.
CREATE TABLE quotation_confirmation_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 quotation_id INTEGER NOT NULL REFERENCES quotations(id),
 option_id INTEGER NOT NULL REFERENCES quotation_options(id),
 requested_by INTEGER NOT NULL REFERENCES users(id),
 submission_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 details TEXT NOT NULL CHECK(json_valid(details)),
 admin_remarks TEXT NOT NULL DEFAULT '',
 payment_verified INTEGER NOT NULL DEFAULT 0 CHECK(payment_verified IN (0,1)),
 availability_verified INTEGER NOT NULL DEFAULT 0 CHECK(availability_verified IN (0,1)),
 decided_by INTEGER REFERENCES users(id),
 decided_at TEXT,
 edited_by INTEGER REFERENCES users(id),
 edited_at TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(status!='approved' OR (payment_verified=1 AND availability_verified=1 AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_confirmation_pending ON quotation_confirmation_requests(option_id,requested_by) WHERE status='pending';
CREATE INDEX idx_confirmation_owner ON quotation_confirmation_requests(requested_by,status,id);
CREATE TABLE quotation_confirmation_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER NOT NULL REFERENCES quotation_confirmation_requests(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL,
 remarks TEXT NOT NULL,
 details TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER confirmation_insert_audit AFTER INSERT ON quotation_confirmation_requests BEGIN
 INSERT INTO quotation_confirmation_audit(request_id,actor_id,status,remarks,details) VALUES(NEW.id,NEW.requested_by,'pending','Submitted',NEW.details);
END;
CREATE TRIGGER confirmation_immutable BEFORE UPDATE ON quotation_confirmation_requests
 WHEN OLD.status!='pending' OR NEW.requested_by!=OLD.requested_by OR NEW.option_id!=OLD.option_id OR NEW.quotation_id!=OLD.quotation_id OR NEW.code!=OLD.code OR NEW.submission_key!=OLD.submission_key OR NEW.created_at!=OLD.created_at
 BEGIN SELECT RAISE(ABORT,'Confirmation details and final decisions are immutable'); END;
CREATE TRIGGER confirmation_edit_guard BEFORE UPDATE OF details ON quotation_confirmation_requests WHEN NEW.details!=OLD.details AND (NEW.edited_by IS NULL OR NEW.edited_at IS NULL OR NEW.revision!=OLD.revision+1) BEGIN SELECT RAISE(ABORT,'Immutable unless an audited Admin edit is recorded'); END;
CREATE TRIGGER confirmation_edit_audit AFTER UPDATE OF details ON quotation_confirmation_requests WHEN NEW.details!=OLD.details BEGIN
 INSERT INTO quotation_confirmation_audit(request_id,actor_id,status,remarks,details) VALUES(NEW.id,NEW.edited_by,'edited','Admin corrected pending request',NEW.details);
END;
CREATE TRIGGER confirmation_decision_audit AFTER UPDATE OF status ON quotation_confirmation_requests WHEN NEW.status!=OLD.status BEGIN
 INSERT INTO quotation_confirmation_audit(request_id,actor_id,status,remarks,details) VALUES(NEW.id,NEW.decided_by,NEW.status,NEW.admin_remarks,NEW.details);
END;
CREATE TRIGGER confirmation_audit_immutable BEFORE UPDATE ON quotation_confirmation_audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
CREATE TRIGGER confirmation_audit_no_delete BEFORE DELETE ON quotation_confirmation_audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
CREATE TRIGGER confirmation_no_delete BEFORE DELETE ON quotation_confirmation_requests BEGIN SELECT RAISE(ABORT,'Confirmation history cannot be deleted'); END;

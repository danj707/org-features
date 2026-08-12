-- Fleet-wide snapshot query for the org-features dashboard.
-- Run against the Rec production database (Metabase: "Rec-Prod-ReadReplica",
-- database_id 4). Returns a single row whose `payload` column is a JSON array
-- with one entry per published organization:
--
--   [slug, id, name, displayName,
--    programs, registrations, memberships, passes, facilities, reservations,
--    age_eligibility, waitlist, sms_messaging, email_messaging, payment_plans,
--    discount_codes, scholarships, gift_cards, custom_booking_questions,
--    custom_forms, instant_booking, gl_accounting, seasons, competitions_leagues]
--
-- Feed the payload to scripts/refresh/merge-snapshot.js to rebuild
-- data/features-data.json.
--
-- Metric definitions (calibrated against the 2026-07-22 bake):
--   programs        program.deleted_at IS NULL
--   registrations   booking live (deleted_at IS NULL) and not canceled
--   memberships     membership.status = 'active'
--   passes          pass.status = 'active'
--   facilities      court live and not archived
--   reservations    reservation.deleted_at IS NULL (canceled included)
--   age_eligibility distinct live sections with a live age/date_of_birth rule
--   waitlist        live sections with any waitlist_config
--   sms/email       message_delivery rows by channel
--   payment_plans   live sections with a NON-EMPTY available_payment_plans array
--   discount_codes / scholarships / gift_cards   all rows
--   custom_booking_questions   distinct programs with live default questions
--   custom_forms    live forms
--   instant_booking live courts with is_instant_bookable
--   gl_accounting   unarchived gl_accounts
--   seasons         live seasons
--   competitions    non-canceled competitions

WITH orgs AS (
  SELECT id, slug, name, display_name
  FROM organization
  WHERE deleted_at IS NULL AND published_at IS NOT NULL
)
SELECT json_agg(json_build_array(o.slug, o.id::text, o.name, o.display_name,
  COALESCE(p.n,0), COALESCE(b.n,0), COALESCE(m.n,0), COALESCE(ps.n,0), COALESCE(ct.n,0), COALESCE(r.n,0),
  COALESCE(age.n,0), COALESCE(wl.n,0), COALESCE(sms.n,0), COALESCE(em.n,0), COALESCE(pp.n,0), COALESCE(dc.n,0),
  COALESCE(sch.n,0), COALESCE(gc.n,0), COALESCE(cbq.n,0), COALESCE(fm.n,0), COALESCE(ib.n,0), COALESCE(gl.n,0),
  COALESCE(se.n,0), COALESCE(cmp.n,0)) ORDER BY o.slug)::text AS payload
FROM orgs o
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM program WHERE deleted_at IS NULL GROUP BY 1) p ON p.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM booking WHERE deleted_at IS NULL AND canceled_at IS NULL GROUP BY 1) b ON b.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM membership WHERE status='active' GROUP BY 1) m ON m.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM pass WHERE status='active' GROUP BY 1) ps ON ps.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM court WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY 1) ct ON ct.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM reservation WHERE deleted_at IS NULL GROUP BY 1) r ON r.oid=o.id
LEFT JOIN (SELECT l.organization_id oid, COUNT(DISTINCT l.section_id)::int n FROM eligibility_rule_group_lookup l JOIN eligibility_rule er ON er.eligibility_rule_group_id=l.eligibility_rule_group_id WHERE l.section_id IS NOT NULL AND l.deleted_at IS NULL AND er.deleted_at IS NULL AND er.attribute_name IN ('age','date_of_birth') GROUP BY 1) age ON age.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND waitlist_config IS NOT NULL GROUP BY 1) wl ON wl.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM message_delivery WHERE channel='sms' GROUP BY 1) sms ON sms.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM message_delivery WHERE channel='email' GROUP BY 1) em ON em.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND (CASE WHEN available_payment_plans IS NOT NULL AND jsonb_typeof(available_payment_plans)='array' THEN jsonb_array_length(available_payment_plans) ELSE 0 END) > 0 GROUP BY 1) pp ON pp.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM discount_code GROUP BY 1) dc ON dc.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM scholarship GROUP BY 1) sch ON sch.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM gift_card_product GROUP BY 1) gc ON gc.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(DISTINCT program_id)::int n FROM default_booking_question WHERE deleted_at IS NULL GROUP BY 1) cbq ON cbq.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM form WHERE deleted_at IS NULL GROUP BY 1) fm ON fm.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM court WHERE deleted_at IS NULL AND is_instant_bookable=true GROUP BY 1) ib ON ib.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM gl_account WHERE archived_at IS NULL GROUP BY 1) gl ON gl.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM season WHERE deleted_at IS NULL GROUP BY 1) se ON se.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM competition WHERE canceled_at IS NULL GROUP BY 1) cmp ON cmp.oid=o.id

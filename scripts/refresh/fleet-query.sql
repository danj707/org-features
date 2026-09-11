-- Fleet-wide snapshot query for the org-features dashboard.
-- Run against the Rec production database (Metabase: "Rec-Prod-ReadReplica",
-- database_id 4). Returns a single row whose `payload` column is a JSON array
-- with one entry per published organization:
--
--   [slug, id, name, displayName, launched, { core metrics }, { adoption metrics }]
--
-- Feed the payload to scripts/refresh/merge-snapshot.js to rebuild
-- data/features-data.json.
--
-- KEYED, NOT POSITIONAL, and that is deliberate. Until 2026-09-07 this
-- emitted a flat array and merge-snapshot mapped columns onto ADOPTION_KEYS by
-- POSITION — safe while appending, silently catastrophic the first time
-- someone inserted a metric in the middle. With 56 adoption metrics that is
-- not a risk worth carrying, so both objects are keyed by feature key and the
-- merge script reads by name. A key present here and absent from the catalog
-- (or vice versa) is caught by scripts/measured-features.spec.js.
--
-- WHAT "ADOPTION" MEANS HERE: has the org configured or used the thing at
-- least once, lifetime. Not "in the last 30 days" — these are feature-adoption
-- questions, not activity questions.
--
-- Metric definitions and, more importantly, the TRAPS. Every note below is a
-- filter that returns a WRONG NUMBER rather than an error, and every one was
-- measured rather than assumed:
--
--   skill_levels        'all' MEANS NO RESTRICTION and is the commonest value
--                       (29,257 sections). `skill_level IS NOT NULL` reports
--                       54,785 sections as using skill levels when more than
--                       half are explicitly unrestricted.
--   custom_staff_roles  ROLES ARE PLATFORM-SEEDED: "Full Access" exists at 156
--                       orgs and "Limited Access" at 78, median 2 roles per
--                       org across 165. Counting rows measures the seed, not
--                       adoption, so only self-named roles count.
--   storefront_products display_in_store is true on 4,685 of 5,860 products
--                       across 100 orgs — effectively a default. The opt-in is
--                       publish_to_public: 581 products, 74 orgs.
--   group_pricing_tiers THE section_price TABLE NO LONGER EXISTS. Group
--                       pricing now lives in section.pricing_policy as
--                       {"default":{"groupCents":{<group uuid>: cents}}}, so
--                       a non-empty groupCents object is the signal.
--   waivers_contracts   contract_version.type is NOT 'waiver' /
--                       'terms_of_service'. The real values are
--                       facility-policy, registration-policy,
--                       liability-waiver, refund-policy and six more, so
--                       filtering on 'waiver' matches almost nothing.
--   cash_check_payments payment_method_type uses HYPHENS: cash, check,
--                       card-online, card-present, organization-credit, free,
--                       scholarship, gift-card. Not camelCase.
--   custom_email_domains  VERIFIED only (17 of 29 rows). A domain added and
--                       never verified cannot send mail, so counting every row
--                       reports the feature as working when it is not.
--   prerequisites       CONFIGURED, not activated: 1,186 prereq rows exist
--                       across 24 orgs and ZERO are activated, so filtering on
--                       activated_at reads 0 everywhere and hides two dozen
--                       orgs that set them up.
--   ai_assistant        status is 'succeeded', NOT 'completed' (the guess
--                       matches 0 of 5,337 rows), and thread-titler /
--                       bulk-summarizer / routine-draft-summarizer are the
--                       SYSTEM titling threads rather than a person using Seb
--                       — 1,077 turns, and at one org they outnumber the real
--                       ones 59 to 101.
--   ticket_sales        status='pending' is a ticket unpaid in a cart, not a
--                       sale: 5,095 of 17,112 rows.
--   events              DO NOT measure through event_session — that table is
--                       EMPTY platform-wide, so anything joined via it is zero
--                       for everybody.
--   facility_rentals    canceled rentals excluded (142,316 of 696,348).
--   rental_permits      ISSUED only; a draft or revoked permit has no working
--                       public page.
--   registration_windows  NEAR-UNIVERSAL BY CONSTRUCTION — every section gets
--                       a default window, so this is a structural fact rather
--                       than a differentiator. Kept because it is a real
--                       catalog feature and the page can hide it.
--   calendar_sync       THE ONLY ORG-SCOPED SIGNAL IS saved_filter_view.
--                       `oauth_connection` has NO organization_id, and
--                       resolving it through organization_association gives
--                       82 orgs from 29 connections — Rec staff are members
--                       of dozens of orgs, so the obvious join is out by 4x.
--                       Nor is it saved_filter_view alone: that table is
--                       1,017 views across 68 orgs and only 46 views at 18
--                       orgs carry a calendar connection.
--                       DISCONNECTING CLEARS oauth_connection_id AND LEAVES
--                       last_synced_at, so the two readings differ: 18 orgs
--                       are connected today, 20 have ever synced. The OR is
--                       the lifetime one, which is the question this
--                       dashboard asks everywhere else.
--                       Cross-validated against calendar_sync_record, which
--                       carries organization_id directly and returns the
--                       same 18 currently-connected orgs — neither side has
--                       an org the other lacks.
--
-- NOT MEASURED, deliberately: restricted_registration_mode. The catalog said
-- section.registration_mode carries values "other than 'open', e.g.
-- invite_only, waitlist". It does not. The only values are 'section' (58,232)
-- and 'per-session' (4,479), which is about whether you register for a whole
-- section or session by session — a different question entirely. There is no
-- invite-only column on section at all. Measuring `registration_mode <>
-- \'open\'` would report ALL 62,711 sections as restricted, i.e. 100%
-- adoption of a feature with no schema support. It stays unmeasured until the
-- product grows the field.

-- THE ORG SET: every non-deleted organization EXCEPT sandboxes, launched or
-- not. Measured 2026-09-07: 167 live orgs, of which 23 carry "sandbox" in the
-- slug or the display name and are excluded. That leaves 144 — 73 launched
-- and 71 not.
--
-- Two things worth knowing about those rules:
--
--   * ALL 23 SANDBOXES ARE ALREADY UNLAUNCHED, so the sandbox exclusion does
--     not move any launched-org figure. It only keeps test tenants out of the
--     unlaunched half.
--   * "Launched" is published_at IS NOT NULL — i.e. live on rec.us. It is the
--     only launch-state column on organization; there is no `status` or
--     `is_live`. It travels with each org rather than being filtered on,
--     because an unlaunched org mid-configuration is exactly who you want to
--     look at on an adoption dashboard, and folding it in unlabelled would
--     drag every fleet figure down with orgs that have not opened yet.
--
-- The exclusion matches on slug AND display name, because some sandboxes are
-- only marked in one of the two (costa-mesa's slug is clean, its name is not).
-- It will not catch a misspelling — `jasons-sanbox` exists — and that is left
-- alone rather than chased with a fuzzier pattern that could eat a real org.

WITH orgs AS (
  SELECT id, slug, name, display_name, (published_at IS NOT NULL) AS launched
  FROM organization
  WHERE deleted_at IS NULL
    AND slug NOT ILIKE '%sandbox%'
    AND name NOT ILIKE '%sandbox%'
)
SELECT json_agg(json_build_array(
  o.slug, o.id::text, o.name, o.display_name, o.launched,
  json_build_object(
    'programs', COALESCE(c_programs.n,0),
    'registrations', COALESCE(c_registrations.n,0),
    'memberships', COALESCE(c_memberships.n,0),
    'passes', COALESCE(c_passes.n,0),
    'facilities', COALESCE(c_facilities.n,0),
    'reservations', COALESCE(c_reservations.n,0)
  ),
  -- POSTGRES CAPS json_build_object AT 100 ARGUMENTS and 56 metrics is
  -- 112, so the adoption object is built in chunks and concatenated.
  (
  jsonb_build_object(
    'age_eligibility', COALESCE(a_age_eligibility.n,0),
    'waitlist', COALESCE(a_waitlist.n,0),
    'sms_messaging', COALESCE(a_sms_messaging.n,0),
    'email_messaging', COALESCE(a_email_messaging.n,0),
    'payment_plans', COALESCE(a_payment_plans.n,0),
    'discount_codes', COALESCE(a_discount_codes.n,0),
    'scholarships', COALESCE(a_scholarships.n,0),
    'gift_cards', COALESCE(a_gift_cards.n,0),
    'custom_booking_questions', COALESCE(a_custom_booking_questions.n,0),
    'custom_forms', COALESCE(a_custom_forms.n,0),
    'instant_booking', COALESCE(a_instant_booking.n,0),
    'gl_accounting', COALESCE(a_gl_accounting.n,0),
    'seasons', COALESCE(a_seasons.n,0),
    'competitions_leagues', COALESCE(a_competitions_leagues.n,0),
    'events', COALESCE(a_events.n,0),
    'ticket_sales', COALESCE(a_ticket_sales.n,0),
    'ai_assistant', COALESCE(a_ai_assistant.n,0),
    'ai_routines', COALESCE(a_ai_routines.n,0),
    'grade_eligibility', COALESCE(a_grade_eligibility.n,0),
    'residency_eligibility', COALESCE(a_residency_eligibility.n,0),
    'prerequisites', COALESCE(a_prerequisites.n,0),
    'registration_windows', COALESCE(a_registration_windows.n,0),
    'group_early_access_windows', COALESCE(a_group_early_access_windows.n,0),
    'required_participant_info', COALESCE(a_required_participant_info.n,0),
    'waivers_contracts', COALESCE(a_waivers_contracts.n,0),
    'form_on_file_reuse', COALESCE(a_form_on_file_reuse.n,0),
    'guests_allowed', COALESCE(a_guests_allowed.n,0),
    'skill_levels', COALESCE(a_skill_levels.n,0),
    'addons', COALESCE(a_addons.n,0),
    'instructors', COALESCE(a_instructors.n,0),
    'instructor_certifications', COALESCE(a_instructor_certifications.n,0),
    'memberships', COALESCE(a_memberships.n,0),
    'auto_renew_memberships', COALESCE(a_auto_renew_memberships.n,0),
    'passes', COALESCE(a_passes.n,0),
    'benefit_rules', COALESCE(a_benefit_rules.n,0),
    'physical_access_devices', COALESCE(a_physical_access_devices.n,0),
    'facility_rentals', COALESCE(a_facility_rentals.n,0),
    'rental_applications', COALESCE(a_rental_applications.n,0),
    'reservation_buffers', COALESCE(a_reservation_buffers.n,0),
    'security_deposits', COALESCE(a_security_deposits.n,0)
  )
  ||
  jsonb_build_object(
    'rental_permits', COALESCE(a_rental_permits.n,0),
    'group_reservation_windows', COALESCE(a_group_reservation_windows.n,0),
    'store_credit', COALESCE(a_store_credit.n,0),
    'structured_refund_policies', COALESCE(a_structured_refund_policies.n,0),
    'group_pricing_tiers', COALESCE(a_group_pricing_tiers.n,0),
    'tax_collection', COALESCE(a_tax_collection.n,0),
    'cash_check_payments', COALESCE(a_cash_check_payments.n,0),
    'custom_email_domains', COALESCE(a_custom_email_domains.n,0),
    'notification_subscriptions', COALESCE(a_notification_subscriptions.n,0),
    'audience_segments', COALESCE(a_audience_segments.n,0),
    'storefront_products', COALESCE(a_storefront_products.n,0),
    'pos_desk_locations', COALESCE(a_pos_desk_locations.n,0),
    'cash_reconciliation', COALESCE(a_cash_reconciliation.n,0),
    'custom_staff_roles', COALESCE(a_custom_staff_roles.n,0),
    'alternate_identities', COALESCE(a_alternate_identities.n,0),
    'crm_household_notes', COALESCE(a_crm_household_notes.n,0),
    'calendar_sync', COALESCE(a_calendar_sync.n,0)
  )
  )::json
) ORDER BY o.slug)::text AS payload
FROM orgs o
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM program WHERE deleted_at IS NULL GROUP BY 1) c_programs ON c_programs.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM booking WHERE deleted_at IS NULL AND canceled_at IS NULL GROUP BY 1) c_registrations ON c_registrations.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM membership WHERE status='active' GROUP BY 1) c_memberships ON c_memberships.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM pass WHERE status='active' GROUP BY 1) c_passes ON c_passes.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM court WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY 1) c_facilities ON c_facilities.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM reservation WHERE deleted_at IS NULL GROUP BY 1) c_reservations ON c_reservations.oid=o.id
LEFT JOIN (SELECT l.organization_id oid, COUNT(DISTINCT l.section_id)::int n FROM eligibility_rule_group_lookup l JOIN eligibility_rule er ON er.eligibility_rule_group_id=l.eligibility_rule_group_id WHERE l.section_id IS NOT NULL AND l.deleted_at IS NULL AND er.deleted_at IS NULL AND er.attribute_name IN ('age','date_of_birth') GROUP BY 1) a_age_eligibility ON a_age_eligibility.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND waitlist_config IS NOT NULL GROUP BY 1) a_waitlist ON a_waitlist.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM message_delivery WHERE channel='sms' GROUP BY 1) a_sms_messaging ON a_sms_messaging.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM message_delivery WHERE channel='email' GROUP BY 1) a_email_messaging ON a_email_messaging.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND (CASE WHEN available_payment_plans IS NOT NULL AND jsonb_typeof(available_payment_plans)='array' THEN jsonb_array_length(available_payment_plans) ELSE 0 END) > 0 GROUP BY 1) a_payment_plans ON a_payment_plans.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM discount_code GROUP BY 1) a_discount_codes ON a_discount_codes.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM scholarship GROUP BY 1) a_scholarships ON a_scholarships.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM gift_card_product GROUP BY 1) a_gift_cards ON a_gift_cards.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(DISTINCT program_id)::int n FROM default_booking_question WHERE deleted_at IS NULL GROUP BY 1) a_custom_booking_questions ON a_custom_booking_questions.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM form WHERE deleted_at IS NULL GROUP BY 1) a_custom_forms ON a_custom_forms.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM court WHERE deleted_at IS NULL AND is_instant_bookable=true GROUP BY 1) a_instant_booking ON a_instant_booking.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM gl_account WHERE archived_at IS NULL GROUP BY 1) a_gl_accounting ON a_gl_accounting.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM season WHERE deleted_at IS NULL GROUP BY 1) a_seasons ON a_seasons.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM competition WHERE canceled_at IS NULL GROUP BY 1) a_competitions_leagues ON a_competitions_leagues.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM event WHERE deleted_at IS NULL GROUP BY 1) a_events ON a_events.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM event_ticket WHERE deleted_at IS NULL AND canceled_at IS NULL AND status='confirmed' GROUP BY 1) a_ticket_sales ON a_ticket_sales.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM ai_chat_turn WHERE status='succeeded' AND COALESCE(agent,'') NOT IN ('thread-titler','bulk-summarizer','routine-draft-summarizer','routine') GROUP BY 1) a_ai_assistant ON a_ai_assistant.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM ai_chat_routine GROUP BY 1) a_ai_routines ON a_ai_routines.oid=o.id
LEFT JOIN (SELECT l.organization_id oid, COUNT(DISTINCT l.section_id)::int n FROM eligibility_rule_group_lookup l JOIN eligibility_rule er ON er.eligibility_rule_group_id=l.eligibility_rule_group_id WHERE l.section_id IS NOT NULL AND l.deleted_at IS NULL AND er.deleted_at IS NULL AND er.attribute_name='grade' GROUP BY 1) a_grade_eligibility ON a_grade_eligibility.oid=o.id
LEFT JOIN (SELECT oid, SUM(n)::int n FROM (SELECT organization_id oid, COUNT(*)::int n FROM residency_zipcode_group GROUP BY 1 UNION ALL SELECT organization_id, COUNT(*)::int FROM residency_polygon_group GROUP BY 1) u GROUP BY 1) a_residency_eligibility ON a_residency_eligibility.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM prereq GROUP BY 1) a_prerequisites ON a_prerequisites.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM registration_window WHERE type='default' GROUP BY 1) a_registration_windows ON a_registration_windows.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM registration_window WHERE type='group' AND group_id IS NOT NULL GROUP BY 1) a_group_early_access_windows ON a_group_early_access_windows.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND required_info_config IS NOT NULL GROUP BY 1) a_required_participant_info ON a_required_participant_info.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM contract_version GROUP BY 1) a_waivers_contracts ON a_waivers_contracts.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM form_lookup WHERE use_form_on_file = true GROUP BY 1) a_form_on_file_reuse ON a_form_on_file_reuse.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM program WHERE deleted_at IS NULL AND allow_guests = true GROUP BY 1) a_guests_allowed ON a_guests_allowed.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND skill_level IS NOT NULL AND skill_level::text <> 'all' GROUP BY 1) a_skill_levels ON a_skill_levels.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM addon GROUP BY 1) a_addons ON a_addons.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM instructor GROUP BY 1) a_instructors ON a_instructors.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM instructor_certification GROUP BY 1) a_instructor_certifications ON a_instructor_certifications.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM group_schema WHERE type='membership' GROUP BY 1) a_memberships ON a_memberships.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM group_schema WHERE auto_renewal = true GROUP BY 1) a_auto_renew_memberships ON a_auto_renew_memberships.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM pass_schema GROUP BY 1) a_passes ON a_passes.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM benefit_rule GROUP BY 1) a_benefit_rules ON a_benefit_rules.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM physical_access_device GROUP BY 1) a_physical_access_devices ON a_physical_access_devices.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM facility_rental WHERE status <> 'canceled' GROUP BY 1) a_facility_rentals ON a_facility_rentals.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM rental_application GROUP BY 1) a_rental_applications ON a_rental_applications.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM court WHERE deleted_at IS NULL AND buffer_minutes_between_reservations > 0 GROUP BY 1) a_reservation_buffers ON a_reservation_buffers.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM deposit GROUP BY 1) a_security_deposits ON a_security_deposits.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM facility_rental_permit WHERE status='issued' GROUP BY 1) a_rental_permits ON a_rental_permits.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM site_reservation_window GROUP BY 1) a_group_reservation_windows ON a_group_reservation_windows.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM credit GROUP BY 1) a_store_credit ON a_store_credit.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM structured_refund_policy GROUP BY 1) a_structured_refund_policies ON a_structured_refund_policies.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM section WHERE deleted_at IS NULL AND jsonb_typeof(pricing_policy #> '{default,groupCents}') = 'object' AND (SELECT COUNT(*) FROM jsonb_object_keys(pricing_policy #> '{default,groupCents}')) > 0 GROUP BY 1) a_group_pricing_tiers ON a_group_pricing_tiers.oid=o.id
LEFT JOIN (SELECT oid, SUM(n)::int n FROM (SELECT organization_id oid, COUNT(*)::int n FROM product WHERE tax_bps > 0 GROUP BY 1 UNION ALL SELECT organization_id, COUNT(*)::int FROM court WHERE deleted_at IS NULL AND tax_bps > 0 GROUP BY 1) u GROUP BY 1) a_tax_collection ON a_tax_collection.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM payment WHERE payment_method_type IN ('cash','check') GROUP BY 1) a_cash_check_payments ON a_cash_check_payments.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM organization_email_domain WHERE status='verified' GROUP BY 1) a_custom_email_domains ON a_custom_email_domains.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM subscription GROUP BY 1) a_notification_subscriptions ON a_notification_subscriptions.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM segment WHERE archived_at IS NULL GROUP BY 1) a_audience_segments ON a_audience_segments.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM product WHERE publish_to_public = true GROUP BY 1) a_storefront_products ON a_storefront_products.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM desk_location GROUP BY 1) a_pos_desk_locations ON a_pos_desk_locations.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM cash_summary_report GROUP BY 1) a_cash_reconciliation ON a_cash_reconciliation.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM organization_role WHERE name NOT IN ('Full Access','Limited Access') GROUP BY 1) a_custom_staff_roles ON a_custom_staff_roles.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM user_alternate_identity GROUP BY 1) a_alternate_identities ON a_alternate_identities.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM household_note GROUP BY 1) a_crm_household_notes ON a_crm_household_notes.oid=o.id
LEFT JOIN (SELECT organization_id oid, COUNT(*)::int n FROM saved_filter_view WHERE oauth_connection_id IS NOT NULL OR last_synced_at IS NOT NULL GROUP BY 1) a_calendar_sync ON a_calendar_sync.oid=o.id

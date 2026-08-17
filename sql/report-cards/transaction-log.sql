/* ============================================================
   Transaction Log — shared, org-parameterized card
   ("✅ Transaction Log Report"), database 4 (Rec-Prod-ReadReplica).
   Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date

   THIS FILE is the source of truth for the card SQL. Applying it via the
   Metabase API/MCP regenerates ALL template tags as Text — after saving,
   re-flip Start Date / End Date back to type Date in the Metabase UI, or the
   date/single parameters stop matching and the card errors.

   WHAT THIS IS: a reproduction of the "Transaction Log" CSV the product
   exports. It is the transaction-level companion to the Item Log: one row per
   transaction event (the Item Log's 1,180 line items for Chico's 2026-08-08 →
   2026-08-15 period roll up to exactly these 630 transactions), with the
   payment-method split (credits / cash / check / card / scholarship / gift
   card), fees, and cart totals finance reconciles against.

   Both reports are surfaced together on /ps/remittance — same billing period,
   one column each. (The Item Log's SQL lives in the rental-report repo at
   sql/report-cards/item-log.sql.)

   VALIDATED column-for-column against Chico's real manual export
   (2026-08-08 → 2026-08-15): 630 rows, all 24 columns identical by checksum.
   Four rules are non-obvious — don't "clean them up":

     1. Transaction ID   = last 8 hex of transaction_event_batch_id, uppercased
                           (same rule as the Item Log; NOT the event id).
     2. Staff            = '-' for system-generated transactions (auto-renewals
                           etc.), 'Self Serve' when the customer created their
                           own transaction, otherwise the creator's name. Note
                           this differs from "Transaction Created By", which is
                           always the raw creator — a staff member buying for
                           themselves reads 'Self Serve' as Staff but shows
                           their own name as Created By.
     3. Item Count       = DISTINCT non-tax order items in the transaction.
                           Tax lines are excluded, and a transaction can carry
                           MANY tax lines (fleet-wide: 3,538 with 2, some with
                           100+), so this must be a real count — subtracting
                           one per taxed transaction is wrong outside the
                           validation window.
     4. Money formatting = zero renders as a bare '$0', never '$0.00';
                           everything else is $#,##0.00.

   Method is a comma-joined, de-duplicated list of the transaction's payment
   methods in ARRAY ORDER (split tender reads "Card, Account Credit"). Ordering
   matters: string_agg(DISTINCT ...) would sort alphabetically and produce
   "Account Credit, Card", which the product never emits.

   The window is INCLUSIVE of end_date. datetime_at_primary_timezone is already
   local wall-clock time, so no timezone conversion is applied.
   ============================================================ */
WITH items AS (
  /* Non-tax item count per transaction. Scoped to the same org+window as the
     outer query so this stays an indexed range scan rather than a full-org
     aggregate. */
  SELECT
    ilr.transaction_event_batch_id AS batch,
    count(DISTINCT ilr.order_item_id)
      FILTER (WHERE ilr.order_item_type <> 'tax') AS non_tax_items
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    [[AND ilr.datetime_at_primary_timezone >= {{start_date}}]]
    [[AND ilr.datetime_at_primary_timezone <  {{end_date}} + INTERVAL '1 day']]
  GROUP BY 1
)
SELECT
  TO_CHAR(tr.datetime_at_primary_timezone, 'MM/DD/YYYY FMHH12:MI AM')    AS "Date",
  COALESCE(NULLIF(TRIM(tr.desk_location_name), ''), 'None')              AS "Location",

  CASE WHEN tr.transaction_event_source = 'system' THEN '-'
       WHEN tr.creator_id = tr.customer_id         THEN 'Self Serve'
       ELSE COALESCE(tr.creator_first_name,'')||' '||COALESCE(tr.creator_last_name,'')
  END                                                                   AS "Staff",

  UPPER(RIGHT(tr.transaction_event_batch_id::text, 8))                  AS "Transaction ID",

  COALESCE(tr.customer_first_name,'')||' '||COALESCE(tr.customer_last_name,'') AS "Customer Name",
  COALESCE(tr.customer_email, '')                                       AS "Customer Email",

  /* Stored as bare digits; the product renders 10-digit US numbers as
     (XXX) XXX-XXXX and leaves anything else (blank, extensions, +country) as-is. */
  CASE WHEN tr.customer_phone ~ '^[0-9]{10}$'
       THEN '(' || SUBSTRING(tr.customer_phone,1,3) || ') '
                || SUBSTRING(tr.customer_phone,4,3) || '-'
                || SUBSTRING(tr.customer_phone,7,4)
       ELSE COALESCE(tr.customer_phone, '')
  END                                                                   AS "Customer Phone",

  COALESCE(tr.customer_rec_id, '')                                      AS "Customer Rec ID",
  tr.transaction_event_type                                             AS "Type",
  COALESCE(tr.creator_first_name,'')||' '||COALESCE(tr.creator_last_name,'') AS "Transaction Created By",

  COALESCE(i.non_tax_items, 0)                                          AS "Item Count",

  CASE WHEN tr.non_tax_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.non_tax_amount/100.0,'FM999,999,990.00') END        AS "Cart Value",
  CASE WHEN tr.tax_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.tax_amount/100.0,'FM999,999,990.00') END            AS "Total Tax on Cart Items",
  CASE WHEN tr.subtotal = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.subtotal/100.0,'FM999,999,990.00') END              AS "Cart Sub-Total",
  CASE WHEN tr.ticket_service_fee_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.ticket_service_fee_amount/100.0,'FM999,999,990.00') END AS "Ticket Service Fee",
  CASE WHEN tr.credit_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.credit_amount/100.0,'FM999,999,990.00') END         AS "Credits",
  CASE WHEN tr.cash_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.cash_amount/100.0,'FM999,999,990.00') END           AS "Cash",
  CASE WHEN tr.check_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.check_amount/100.0,'FM999,999,990.00') END          AS "Check",
  CASE WHEN tr.card_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.card_amount/100.0,'FM999,999,990.00') END           AS "Credit Card",
  CASE WHEN tr.transaction_fees = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.transaction_fees/100.0,'FM999,999,990.00') END      AS "Credit Card Processing Fee",
  CASE WHEN tr.scholarship_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.scholarship_amount/100.0,'FM999,999,990.00') END    AS "Scholarship",
  CASE WHEN tr.gift_card_amount = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.gift_card_amount/100.0,'FM999,999,990.00') END      AS "Gift Card",
  CASE WHEN tr.total = 0 THEN '$0'
       ELSE '$'||TO_CHAR(tr.total/100.0,'FM999,999,990.00') END                 AS "Total Transaction Amount",

  (SELECT string_agg(lbl, ', ' ORDER BY first_pos)
     FROM (SELECT CASE x
                    WHEN 'card-online'         THEN 'Card'
                    WHEN 'card-present'        THEN 'Card'
                    WHEN 'cash'                THEN 'Cash'
                    WHEN 'check'               THEN 'Check'
                    WHEN 'free'                THEN 'Free'
                    WHEN 'organization-credit' THEN 'Account Credit'
                    WHEN 'scholarship'         THEN 'Scholarship'
                    WHEN 'gift-card'           THEN 'Gift Card'
                    ELSE INITCAP(REPLACE(x,'-',' '))
                  END      AS lbl,
                  MIN(ord) AS first_pos
             FROM UNNEST(tr.transaction_methods) WITH ORDINALITY AS u(x, ord)
             GROUP BY 1) s)                                             AS "Method",

  /* Machine-readable companions for the UI — stripped from the CSV download so
     the exported file matches the product export column-for-column. */
  tr.datetime_at_primary_timezone                                       AS "_sort_at",
  tr.total                                                              AS "_total_cents",
  tr.transaction_event_type                                             AS "_type_raw"

FROM materialized.transaction_report tr
LEFT JOIN items i ON i.batch = tr.transaction_event_batch_id
WHERE
  tr.organization_id = {{org_id}}::uuid
  [[AND tr.datetime_at_primary_timezone >= {{start_date}}]]
  [[AND tr.datetime_at_primary_timezone <  {{end_date}} + INTERVAL '1 day']]
ORDER BY
  tr.datetime_at_primary_timezone DESC,
  tr.transaction_event_id

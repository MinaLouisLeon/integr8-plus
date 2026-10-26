/**
 * What each error code the API can return means to the person who met it
 * (ADR-0012), in English. Arabic is in `api-errors.ar.ts`.
 *
 * The codes are the contract: `API_ERROR_CODES` lists every one, and a test
 * fails when a code has no message here (or in a key it points to, see
 * `API_ERROR_MESSAGE_KEYS`), or when a message is left for a code the API no
 * longer returns. The server's own English `message` is never shown.
 *
 * - **One message per code, for every place it is returned.** The same code
 *   can come from more than one screen, so a message says what is wrong and
 *   what to do without naming a screen. A screen that knows more — a ledger
 *   line, a link to the rules — adds it around this message, or keeps a
 *   richer message of its own for that code.
 * - **No placeholders.** A refusal carries a code and, at most, details with
 *   their own codes; nothing else in it is safe to put into a sentence.
 * - **A code with a dot nests.** `auth.invalid_token` is `auth.invalid_token`
 *   here, because i18next reads the dot as a level.
 */
export const apiErrorsEn = {
  access_changed:
    'Someone else changed these access notes while you were offline. Choose which to keep.',
  account_archived: 'An account here is archived. Choose one in use.',
  account_not_found: 'No such account. Choose one from the chart.',
  account_not_usable: 'Choose an account that exists and is in use.',
  account_number_taken: 'Another customer already has this account number. Choose another.',
  ai_action_already_executed: 'This action was already carried out. Nothing was done twice.',
  ai_action_expired:
    'This proposal has expired or the record changed. Ask the assistant again for a fresh one.',
  ai_action_not_found: 'No such proposal. It may have been cleared; ask the assistant again.',
  ai_budget_unavailable: 'The assistant is paused for now. Try again later.',
  ai_concurrency_limit: 'Too many questions are being answered at once. Wait for one to finish.',
  ai_conversation_not_found: 'No such conversation.',
  ai_daily_quota_exceeded:
    'Today’s assistant messages are used up. They reset at midnight UTC; ask your company administrator or Integr8 about the limit.',
  ai_daily_token_quota_exceeded:
    'Today’s assistant allowance is used up. It resets at midnight UTC; ask your company administrator about your share.',
  ai_disabled: 'The assistant is not included for your company, or is switched off. Ask Integr8.',
  ai_level_required: 'This needs a higher assistant level than your company’s plan includes.',
  ai_member_budget_exceeded:
    'Your assistant allowance for this month is used up. It resets on the first of next month, UTC.',
  ai_member_limits_changed:
    'Somebody else changed this person’s assistant share first. Reload and try again.',
  ai_monthly_quota_exceeded:
    'This month’s assistant messages are used up. They reset on the first of next month, UTC.',
  ai_monthly_token_quota_exceeded:
    'This month’s assistant allowance is used up. It resets on the first of next month, UTC.',
  ai_policy_changed: 'Somebody else changed this policy first. Reload and try again.',
  ai_policy_invalid:
    'The policy is inconsistent: an enabled level needs a quota mode and the limits it names.',
  ai_provider_unavailable: 'The assistant could not reach its model. Try again in a moment.',
  ai_request_in_progress:
    'This question is still being answered. Wait for the answer rather than sending it again.',
  ai_shares_over_total:
    'The shares would add up to more than 100% of the company’s allowance. Lower another person’s share first.',
  ai_tool_forbidden: 'Your role may not use this with the assistant.',
  ai_validation_failed: 'The assistant could not use this request as sent.',
  allocation_mismatch:
    'A payment is put only against the same customer’s invoices, in its own currency.',
  allocation_removed: 'This was already taken off the invoice. Reload to see the payment as it is.',
  already_drafted:
    'An order was already drafted from one of these suggestions. Reload the plan to see it.',
  already_posted: 'This has already been posted. Nothing was moved twice.',
  already_reversed: 'This journal has already been reversed.',
  already_set_up: 'The ledger is already set up.',
  already_submitted:
    'This form was submitted from somewhere else while you were offline. Your answers were not sent.',
  answers_changed:
    'These answers were changed on another device while you were offline. Choose which to keep.',
  app_icon_not_found: 'The app icon must be an image uploaded by this company. Upload it again.',
  asset_not_at_site: 'This asset is not at the job’s site. Choose one of that site’s assets.',
  asset_not_on_work_order: 'This asset is not one of the job’s assets. Link it to the job first.',
  asset_retired: 'This asset is retired. It takes no new work, condition or form.',
  asset_unavailable: 'This asset no longer exists, or is no longer at one of your sites.',
  assignee_not_member: 'Assign it to an active member of your company.',
  attachment_id_taken:
    'This file clashed with another one. Discard the change and add the file again.',
  attachment_removed: 'This attachment was already removed.',
  auth: {
    identity_provider_unavailable:
      'Signing in is not available just now. Try again in a few minutes.',
    impersonation_denied: 'You cannot open this company as that person.',
    invalid_token: 'Your session has ended. Sign in again.',
    invitation_invalid:
      'This invitation is no longer valid. It may have been used, withdrawn or expired. Ask for a new one.',
    not_a_member: 'Your account is not a member of this company. Ask its owner to invite you.',
    refresh_token_reuse: 'This session was ended to keep your account safe. Sign in again.',
    session_revoked: 'You were signed out of this session. Sign in again.',
    weak_password: 'Choose a stronger password: longer, and not easy to guess.',
  },
  barcode_taken: 'Another item already has this barcode.',
  batch_expired: 'This batch has expired. Confirm to use it anyway and say why.',
  before_due_from: 'The “due by” date must be after the “due from” date.',
  before_start: 'That date is before the ledger starts. Date it on or after the start date.',
  billing_invoiced: 'Integr8 invoices this company directly. To change the plan, contact Integr8.',
  billing_not_configured: 'Billing is not set up on this server. Contact Integr8.',
  blocked: 'Waiting for an earlier change to the same record to be sent first.',
  body_too_large: 'What was sent is too large. Send less at a time.',
  breaking_changes_unacknowledged:
    'Publishing changes fields in ways that affect existing submissions or drafts. Review the changes, then confirm to publish.',
  build_token_rejected: 'The build token was not accepted.',
  category_name_taken: 'There is already a category with this name.',
  category_not_found: 'This category does not exist. Choose another.',
  category_not_usable: 'This category is no longer in use. Choose another.',
  checklist_item_unknown: 'This checklist item is no longer on the job.',
  claim_closed: 'This claim has been decided, so the receipt was not added.',
  claim_not_ready:
    'The claim this receipt belongs to has not been sent yet. The receipt follows it.',
  closing_journal: 'A year-end closing journal is reversed by reopening its year.',
  code_taken: 'This code is already in use. Choose another.',
  comment_id_taken:
    'This note clashed with another one. Discard the change and write the note again.',
  completion_blocked: 'This job cannot be completed yet: something it needs is still missing.',
  component_kind: 'A component is a stock or non-stock item. Put labour in the labour cost.',
  confirmed: 'This rule set is confirmed and no longer changes. Add a new one from a later month.',
  contact_not_customers: 'Choose one of the customer’s contacts.',
  contact_not_found: 'This contact is not one of the customer’s. Choose another.',
  contains_itself: 'An item cannot be built from itself, or from anything built from it.',
  cost_unknown: 'Some of this stock has no cost recorded: write the lines out with the amounts.',
  count_not_draft: 'This stock count has already been posted or cancelled.',
  credit_note_empty: 'Add at least one line before issuing.',
  credit_note_not_draft: 'Only a draft credit note changes.',
  credit_over_balance: 'This credit note takes off more than the invoice still owes.',
  crew_member_unknown:
    'Someone on the crew is not an active member of the company. Choose active members.',
  cursor_invalid: 'The phone’s place in the sync was not recognised. It will download again.',
  customer_closed: 'This customer is closed and takes no new work. Reopen it first.',
  customer_fixed: 'An invoice made from an order or a job keeps its customer.',
  customer_not_found: 'This customer does not exist. Choose another.',
  customer_on_hold: 'This customer is on hold. Check with accounts before creating work.',
  customer_stock_location: 'This location holds the customer’s stock. Deliver from one of ours.',
  customer_stock_stays:
    'Stock held as the customer’s is a record of what they have, and is not moved from there. Choose one of our locations.',
  date_taken: 'Pay terms already start that day. Change those instead.',
  default_pipeline: 'This is the default pipeline. Make another pipeline the default first.',
  deletion_scheduled: 'This company is already scheduled for deletion.',
  deliberate_probe: 'A deliberate error, raised to test reporting.',
  description_required: 'Describe the line: a line without an item needs a description.',
  document_expired: "This document's link has been stopped by the company that issued it.",
  document_expiry_past: 'The expiry date has already passed. Choose a later one.',
  document_fields_invalid:
    'Some document fields are missing or too long. Check the fields marked below.',
  document_link_unavailable:
    'Documents cannot be made yet: this server has no web address for the QR code. Ask Integr8.',
  document_template_archived: 'This template is archived. Choose another one.',
  document_template_changed:
    'Someone else saved this template meanwhile. Open it again to see their changes.',
  document_template_image_unusable:
    'A picture in the template is not usable. Upload it again as a PNG, JPEG or WebP image.',
  document_template_invalid: 'The template has problems. Each one is listed below.',
  document_template_problem: 'This part of the template needs fixing.',
  document_template_wrong_form: 'This template belongs to another form.',
  double_booked: 'This person is on another job at that time.',
  draft_changed:
    'The draft was saved again since you reviewed it. Review it again before publishing.',
  draft_conflict:
    'This draft was changed elsewhere while you were editing it. Reload it, then make your change again.',
  due_before_issue: 'The due date is before today. Choose today or later.',
  due_window_invalid: 'The job is due to finish before it is due to start. Check the dates.',
  duplicate_component: 'Each component appears once. Put the whole quantity on one line.',
  duplicate_contact:
    'The customer already has a contact with this email or phone. Choose them instead.',
  empty_run: 'Nobody is paid in this run.',
  end_before_hire: 'Employment must end on or after the hire date.',
  end_pairing: 'Give an end date with its reason, or neither.',
  eta_arithmetic: "The document's amounts do not add up. Prepare the invoice again.",
  eta_certificate_unreadable:
    'That is not a certificate that can be read. Export the public certificate from the token and try again.',
  eta_credentials_missing:
    "Save the company's ETA client ID and secret in the e-invoicing settings first.",
  eta_credentials_rejected:
    "The tax authority refused the company's ETA credentials. Check the client ID and secret registered in the ETA portal.",
  eta_credentials_unreadable:
    'The saved ETA credentials can no longer be opened on this server. Enter them again.',
  eta_disabled: "E-invoicing is switched off in this company's settings.",
  eta_document_live:
    'This invoice already has an ETA document that is being sent, sent or accepted. Cancel it at the ETA before preparing another.',
  eta_document_unsigned: 'An unsigned document is never sent. Sign it first.',
  eta_environment_changed:
    'This document was prepared for another ETA environment. Prepare the invoice again.',
  eta_key_missing:
    'ETA credentials cannot be stored or used until the e-invoicing key is set on the server. Ask Integr8 to set it.',
  eta_no_certificates: 'Choose the certificate allowed to sign in the e-invoicing settings first.',
  eta_not_found: 'The tax authority does not know that document.',
  eta_not_ready: 'The invoice is not ready to become an ETA document. Fix the items listed.',
  eta_private_key_refused: 'Send only the public certificate, never a private key.',
  eta_production_disabled:
    'The ETA production environment is not enabled on this server. Ask Integr8.',
  eta_production_owner_only: "Only the company's owner can switch e-invoicing to production.",
  eta_production_unconfirmed: 'Confirm that documents will go to the real tax authority.',
  eta_rate_limited: 'The tax authority asked us to slow down. Try again in a minute.',
  eta_refused: 'The tax authority refused the request.',
  eta_request_closed: 'That signing request is already finished.',
  eta_request_unavailable:
    'That signing request has expired, finished, or is being signed on another computer.',
  eta_schema_invalid: "The document does not pass the tax authority's schema.",
  eta_schema_missing: "Fetch the tax authority's invoice schema in the e-invoicing settings first.",
  eta_schema_unreadable: "The tax authority's answer is not a schema that can be used.",
  eta_signature_refused: 'The signature was refused. The document is ready to be signed again.',
  eta_staff_refused:
    "Integr8 staff cannot do this for a company. Sign in as the company's own member.",
  eta_state_conflict: 'This document has moved on since you opened it. Reload to see where it is.',
  eta_tax_rate_repeated: 'Give each tax rate once.',
  eta_unreachable: 'The tax authority could not be reached. Try again later.',
  export_not_ready:
    'A company is scheduled for deletion only once its export is ready. Wait for the export, then try again.',
  filter_needs_form: 'Choose a form before filtering by an answer.',
  form_not_on_work_order: 'This form is no longer one of the job’s forms.',
  form_not_published:
    'Publish the form first; its documents are designed against the published version.',
  form_started: 'Someone has started this form for this job, so it stays on the job.',
  form_unknown: 'Choose a published form.',
  form_version_unavailable:
    'This version of the form is no longer available. Fill it again on the current version.',
  hr_key_missing:
    'ID, insurance and bank numbers cannot be stored or shown until the HR data key is set on the server. Ask Integr8 to set it.',
  idempotency_key_in_progress:
    'This request is still being processed. Wait a moment, then try again.',
  idempotency_key_required: 'This request could not be sent safely. Try again.',
  idempotency_key_reused: 'This request clashed with an earlier one. Try again.',
  in_progress: 'This change is already being applied. It will finish on its own.',
  insufficient_stock: 'There is not enough stock there for this. Nothing was moved.',
  internal_error: 'Something went wrong on our side. Try again; if it keeps happening, tell us.',
  invalid_body: 'What was sent could not be read. Try again.',
  invalid_cursor: 'This page link is no longer valid. Start from the first page.',
  invalid_definition: 'This form has problems to fix before it can be published or test-filled.',
  invalid_filter: 'A filter cannot be applied. Change it or remove it.',
  invalid_lines: 'Some lines name an account or customer that cannot be used.',
  invalid_signature: 'The signature did not verify.',
  invalid_signup_token:
    'This link is no longer valid. It may have been used already, or it may have expired. Start again and we will send a new one.',
  invalid_submission: 'Some answers cannot be accepted. Check the questions marked.',
  invalid_transition: 'It cannot move there from where it is now. Choose another stage or status.',
  invalid_window: 'Choose a period of up to 62 days that ends after it starts.',
  invoice_empty: 'Add at least one line before issuing.',
  invoice_not_draft: 'Only a draft invoice changes. Credit or void an issued invoice.',
  invoice_not_issued: 'This invoice is not issued, so this cannot be done to it.',
  invoice_settled: 'A payment or a credit note is against this invoice. Credit it instead.',
  item_archived: 'This item is archived. Restore it, or choose another.',
  item_has_stock:
    'This item holds stock. Move or count it to zero before it stops being a stock item.',
  item_not_found: 'This item does not exist. Choose another.',
  item_not_requested: 'This item is not on the request.',
  item_not_tracked: 'This item has no serial numbers or batches. Leave them out.',
  item_repeated: 'Each item goes on one line. Join the lines for the same item.',
  job_already_invoiced: 'This job is already on an invoice. Open that invoice instead.',
  job_not_complete: 'Only a completed job is invoiced.',
  job_type_unknown: 'Choose a current job type.',
  last_owner: 'This is the only owner of the company. Make somebody else an owner first.',
  lead_already_converted:
    'This lead has been converted. Its details now live on the customer; change them there.',
  lead_not_convertible:
    'This lead is ruled out or archived. Move it back to an open status, or restore it, before converting it.',
  lead_not_found: 'This lead does not exist. Choose another.',
  ledger_not_set_up: 'Set up the ledger first.',
  line_not_found: 'This line is not on the order. Reload the order.',
  line_not_from_invoice: 'A line names a line of another invoice. Choose lines of this invoice.',
  line_not_from_source:
    'A line does not come from the order or job this invoice was made from. Remove it.',
  line_repeated: 'Name each line once.',
  link_not_found: 'Something it is linked to no longer exists. Choose again.',
  link_required: 'Link it to a lead, a customer or an opportunity.',
  location_archived: 'This location is archived. Restore it, or choose a current one.',
  location_name_taken: 'There is already a location with this name.',
  location_not_empty: 'This location still holds stock. Move it out before archiving the location.',
  location_not_found: 'This location does not exist. Choose another.',
  location_required: 'Choose the stock location.',
  logo_not_found: 'The logo must be an image uploaded by this company. Upload it again.',
  lost_reason_required: 'Say why it was lost.',
  lot_code_taken: 'This code was used for this item before, as the other kind. Use another code.',
  lot_not_found: 'No such serial number or batch for this item. Check the code.',
  lot_repeated: 'Each serial number or batch is named once.',
  lots_quantity_mismatch: 'The serial numbers or batches do not add up to the quantity.',
  lots_required: 'Give the serial numbers or batch for this item.',
  main_not_image: 'Only an image can be the item’s main image. Choose a photo.',
  media_id_taken: 'This upload clashed with another file. Upload it again.',
  media_in_use:
    'A submission uses this file, so it cannot be deleted. Remove it from the submission first.',
  media_mismatch: 'A file is not the one that was uploaded. Add it again.',
  media_not_found: 'A file was never uploaded. Add it again.',
  media_not_ready:
    'A file this change needs has not finished uploading. It will be sent once it has.',
  media_too_large: 'This file is too large to upload. Choose a smaller one.',
  media_type_refused: 'Files of this type cannot be uploaded. Choose another file.',
  media_unusable: 'A photo, signature or receipt it names was deleted, or is not an image.',
  member_has_van: 'This person already has a van. Unassign it first.',
  member_not_active: 'Only an active member can be given this.',
  member_not_found: 'That member is no longer in the company.',
  member_taken: 'This member already has an employee profile.',
  month_in_future: 'A run is prepared no earlier than the month before. Choose this month or next.',
  month_taken: 'There is already one for this month. Change it, or choose another month.',
  move_required: 'This stage holds open opportunities. Choose the stage they move to.',
  move_target_not_open:
    'Open opportunities move to another open stage of this pipeline. Choose one.',
  mutation_id_reused: 'This change clashed with another one. Discard it and make it again.',
  name_required: 'Give a name, or link the profile to a member.',
  name_taken: 'This name is already in use. Choose another.',
  negative_net:
    'A line pays less than nothing. Reduce its deductions, or carry them to next month.',
  no_bill:
    'This item has no bill of materials in use. Add one before building it or taking it apart.',
  no_billing_account:
    'This company has not subscribed yet, so there is nothing to manage. Start a subscription first.',
  no_confirmed_rules:
    'There is no confirmed rule set in force for this month. Add one in the payroll rules and ask the owner to confirm it.',
  no_due_window: 'This job has no due dates to move.',
  no_supplier:
    'An item to buy has no preferred supplier. Give it one, or order it by hand from purchasing.',
  no_van: 'No van is assigned to you. Ask the office to assign one before recording parts.',
  nobody_assigned: 'Nobody is assigned to this job. Assign someone first.',
  not_a_conflict: 'Only a part use that was refused is resolved this way.',
  not_a_site: 'Only a site location holds the customer’s stock.',
  not_a_van: 'Only a van is assigned to somebody.',
  not_a_warehouse: 'Pick from one of our warehouses.',
  not_approved: 'Only an approved claim is paid back. Reload it to see where it is.',
  not_draft: 'Only a draft written by hand can be changed, posted or discarded.',
  not_on_crew: 'This person is not on the job’s crew. Add them to the crew first.',
  not_own_claim: 'Only the person who claimed can withdraw a claim.',
  not_pending: 'This document no longer waits.',
  not_posted: 'Only something posted is reversed or returned; a draft is discarded.',
  not_stock_item: 'Only stock items have stock or reorder levels.',
  not_waiting: 'This claim has already been decided or withdrawn. Reload it to see where it is.',
  nothing_to_close: 'This year has no income or expense to close; lock its months instead.',
  nothing_to_invoice: 'No parts or time were recorded on this job, so there is nothing to invoice.',
  number_taken: 'Another employee has this employee number.',
  opening_date: 'Date the opening balances on the ledger’s start date.',
  opening_exists: 'The opening balances journal already exists.',
  opportunity_archived: 'This opportunity is archived. Restore it before changing it.',
  opportunity_not_customers: 'Choose one of the customer’s opportunities.',
  order_closed: 'This order is completed or cancelled, and no longer changes.',
  order_empty: 'Add at least one line first.',
  order_incomplete: 'List every current stage of the pipeline exactly once. Reload and try again.',
  order_line_not_found: 'This order has no such line. Reload it.',
  order_not_billable: 'Only a confirmed or delivered order is invoiced.',
  order_not_draft: 'Only a draft order changes.',
  order_not_open: 'Only a confirmed order holds stock.',
  order_not_receivable: 'Goods are received against an approved order.',
  over_delivery: 'That is more than is left to deliver on this line.',
  over_invoice: 'That is more than the invoice still owes.',
  over_invoiced: 'A line invoices more than is left to invoice. Reduce its quantity.',
  over_receipt: 'That is more than this payment has left to put against invoices.',
  over_received: 'That is more than the order has left to receive. Nothing was recorded.',
  over_request: 'That is more than was asked for.',
  over_returned: 'That is more than can be returned. Nothing was recorded.',
  owner_only: 'Only the owner confirms the figures payroll uses.',
  ownership_fixed:
    'Stock has moved at this location, so whose stock it holds can no longer change.',
  part_missing: 'Part of this file has not arrived.',
  part_out_of_range: 'This file does not have that many parts. Upload it again.',
  party_required: 'Choose a customer or a lead.',
  payroll_off: 'Payroll is not switched on. Pay this claim back directly.',
  period_locked: 'That month is locked. Date it in an open month.',
  period_too_long: 'Choose a period of at most two years.',
  permission_not_addable:
    'A company role cannot hold that permission: it is the owner’s, or Integr8’s.',
  photos_missing: 'Photos the job needs are still missing.',
  pipeline_has_open:
    'This pipeline still has open opportunities. Close or move them before archiving it.',
  plan_not_purchasable: 'This plan cannot be bought online just now. Contact support.',
  posting_account: 'An automatic posting uses this account. Choose another in the settings first.',
  price_overlaps:
    'Another price for this supplier, item, currency and quantity already covers some of these days. Change its dates first.',
  price_required: 'This supplier has no price for this item. Enter the price.',
  prices_hidden: 'Prices are for those who manage purchasing or move stock.',
  purchase_cancelled: 'This purchase was already taken off the job.',
  purchase_id_taken: 'This purchase belongs to another job.',
  purchase_not_ready:
    'The purchase this receipt belongs to has not arrived yet. It will be sent again.',
  quote_closed: 'This quote is no longer open.',
  quote_converted: 'This quote has already become a sales order.',
  quote_empty: 'Add at least one line before issuing.',
  quote_expired: 'This quote has expired. A new one has to be issued.',
  quote_not_accepted: 'Only an accepted quote becomes a sales order.',
  quote_not_draft: 'Only a draft quote changes. Revise this quote to edit it.',
  quote_not_issued: 'This quote is no longer open for an answer.',
  quote_not_revisable: 'Only an issued or rejected quote is revised.',
  range_reversed: 'The end of the range is before its start.',
  rate_required: 'This document is in another currency: enter the rate and where it came from.',
  reason_required: 'This needs a reason. Say why.',
  receipt_line_not_found: 'This receipt has no such line. Reload it.',
  received_in_future: 'A payment cannot be received in the future. Choose today or earlier.',
  request_not_open: 'This request has already been picked or withdrawn. Reload to see it.',
  required: 'Something required is missing. Fill it in.',
  required_form_missing: 'A form the job needs has not been submitted.',
  restore_window_passed: 'This file was deleted too long ago to restore.',
  reversal_before_original: 'Date the reversal on or after the journal it reverses.',
  reversal_of_reversal: 'A reversal is not reversed; post the journal again instead.',
  role_above_own: 'You cannot give somebody a role above your own.',
  role_beyond_own: 'This role can do things you cannot, so only the owner gives it.',
  role_holds_grant: 'Their role already includes this.',
  role_in_use: 'Somebody holds this role. Give them another role first.',
  rules_not_confirmed:
    'The rule set for this month is waiting for the owner to confirm it. Payroll uses it once they do.',
  run_approved: 'An approved pay run does not change. Correct it next month.',
  run_not_approved: 'Payslips and the bank file come from an approved run.',
  run_out_of_date:
    'Expense claims changed since this run was calculated. Recalculate it, check it, then approve.',
  same_location: 'Transfer to a different location.',
  same_site: 'The asset is already at this site. Choose another.',
  same_status: 'The asset already has this status. Choose another.',
  schedule_range_invalid: 'Choose a window of up to 45 days that ends after it starts.',
  seat_limit_reached:
    'Every seat on this plan is taken. Remove somebody, or move to a larger plan.',
  self_approval: 'Somebody other than whoever prepared this approves it.',
  serial_in_stock: 'This serial number is already in stock. Check the number.',
  serial_single_unit: 'A serial number is one unit. Name one serial number for each unit.',
  serial_race: 'Checking the serial number again. This retries on its own.',
  serial_taken: 'Another asset already has this serial number. Open that one instead.',
  server_error: 'The change could not be applied just now. It will be tried again.',
  settings_fixed: 'The start date and fiscal year are fixed once a journal is posted.',
  settles_through_payroll: 'This claim is paid back with the next pay run, not from here.',
  shift_ends_before_start: 'This clock-out is earlier than its clock-in.',
  shift_id_taken: 'This shift clashed with someone else’s. Clock in again.',
  shift_open_elsewhere: 'You are already clocked in on another phone. Clock out there first.',
  shift_unavailable: 'This shift is not yours, or was never started.',
  shortage: 'There is not enough stock at this location to complete it. Nothing was moved.',
  signoff_missing: 'The customer has not signed off yet.',
  signup_closed: 'Companies are set up by Integr8. Get in touch and we will set yours up with you.',
  signup_not_configured: 'Signing up is not available here. Contact Integr8.',
  site_not_customers: 'Choose one of the customer’s current sites.',
  site_not_found: 'This site does not exist. Choose another.',
  site_not_job_site:
    'An asset registered on a job is at the job’s site. Leave the site out, or use the job’s site.',
  site_required: 'Choose a site.',
  site_unavailable: 'This site no longer exists.',
  sku_taken: 'Another item already has this SKU.',
  slug_taken: 'Another company already uses this short name. Choose another.',
  slug_unavailable: 'No free name could be found for this company. Try a different company name.',
  spent_in_future: 'An expense is claimed once it is spent: choose today or an earlier date.',
  staff_exists: 'Somebody already signs in with this address.',
  staff_manager_only: 'Only an account made with the terminal command can do this.',
  stage_in_use:
    'Opportunities have been in this stage. Add a new stage instead of changing what it means.',
  stage_needed: 'A pipeline keeps at least one open, one won and one lost stage.',
  stage_not_allowed:
    'Only a photo on a work order is marked before or after. Attach it to a work order, as a photo.',
  stage_not_found: 'This stage does not exist. Choose another.',
  stage_not_open: 'A new opportunity starts at an open stage. Win or lose it afterwards.',
  state_changed: 'While you were offline this job moved on. Decide what to keep.',
  stock_item_bought: 'A stock item comes from a location as a part used, not as a purchase.',
  storage_not_ready: 'This company’s file storage is not ready yet. Try again in a few minutes.',
  storage_quota_exceeded:
    'This would take the company past its storage allowance. Delete some files, or ask for a larger plan.',
  submission_changed:
    'This submission was changed elsewhere since you loaded it. Reload it and try again.',
  submission_draft: 'A draft cannot be made into a document. Submit it first.',
  submission_id_taken:
    'This form clashed with another submission. Discard it and fill it in again.',
  submission_limit_reached:
    'This plan’s submissions for the month are used up. They reset at the start of next month, or a larger plan lifts the limit.',
  submission_state: 'This submission cannot be changed as it is now. Reopen it first.',
  submission_unavailable: 'This form is not yours to change or submit.',
  supplier_inactive: 'This supplier is inactive. Reactivate it first.',
  supplier_name_taken: 'There is already a supplier with this name.',
  supplier_not_found: 'This supplier does not exist. Choose another.',
  tenant_read_only:
    'Your company can look but not change anything until its billing is sorted out. See the billing page.',
  tenant_suspended: 'This account is suspended. Contact support.',
  terminal_account:
    'This account was made with the terminal command and can only be changed there.',
  today_out_of_range:
    'The date the form was filled in is not today. Check the phone’s date and time.',
  transition_not_allowed: 'The job cannot move to that state from where it is now.',
  type_fixed: 'An account that has been posted to keeps its type.',
  unauthorised: 'You are not signed in, or your session has ended. Sign in again.',
  unbalanced: 'Debits and credits must be equal, on two lines or more.',
  unknown_form: 'Choose one of the company’s forms.',
  unknown_job_type: 'Choose one of the company’s job types.',
  unknown_timezone: 'That is not a timezone we recognise.',
  upload_expired: 'This upload took too long to confirm. Upload it again.',
  upload_incomplete: 'The file has not finished arriving. Send the rest, then try again.',
  upload_mismatch:
    'What arrived is not the file that was sent, so it was discarded. Upload it again.',
  upload_not_multipart: 'This file is sent in one piece, not in parts. Upload it again.',
  validation_failed: 'Some of what was entered was not accepted. Check it and try again.',
  version_conflict:
    'Somebody else changed this while you were looking at it. Reload it and try again.',
  view_name_taken: 'You already have a view with this name. Choose another.',
  visit_assignee_missing: 'The person being replaced is not on this visit.',
  visit_assignee_not_on_crew:
    'Only people on the job’s crew can go on its visits. Add them to the crew first.',
  visit_changed: 'This visit was changed elsewhere since you loaded it. Reload and try again.',
  visit_double_booked:
    'Someone on this visit is already on another job at that time. Choose another time or person.',
  visit_final: 'This visit is done or cancelled, so it can no longer change.',
  visit_slot_invalid:
    'A visit must end after it starts and last at most a week. Plan longer work as several visits.',
  waits_for_invoice: 'Post or set aside the invoice it follows first.',
  website_key_invalid: 'This website key is not valid. Ask Integr8 for a new one.',
  website_key_limit:
    'This company already has two live website keys. Revoke one before making another.',
  work_order_changed:
    'This job was changed elsewhere since you loaded it. Reload it and try again.',
  work_order_closed: 'This job is closed. Reopen it before changing it.',
  work_order_not_customers: 'Choose one of the customer’s jobs.',
  work_order_required: 'Choose the job you are on.',
  work_order_unavailable: 'This job is no longer yours to change: it was reassigned or removed.',
  wrong_company:
    'This account belongs to another company. Sign in with an account of this company.',
  year_closed: 'This fiscal year is closed. Reopen it first.',
  year_not_ended: 'This fiscal year has not ended yet.',
  year_not_ready:
    'Post or discard the draft journals, and post or set aside the waiting documents, dated in this year first.',
  year_open: 'This fiscal year is not closed.',
} as const;

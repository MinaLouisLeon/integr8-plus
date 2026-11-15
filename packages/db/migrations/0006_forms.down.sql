-- Removes the forms module (see the up file).

drop table if exists
  website_keys,
  document_field_values,
  documents,
  document_templates,
  submission_action_results,
  submission_links,
  submission_file_uses,
  work_order_forms,
  job_type_forms,
  form_template_files,
  form_template_documents,
  form_templates,
  submission_values,
  submission_events,
  submissions,
  form_versions,
  forms
cascade;
drop function if exists enforce_submission_binding();
drop function if exists enforce_submission_lifecycle();
drop function if exists guard_submission_work_order();
drop function if exists guard_submit_location();
drop function if exists guard_submitted_after_close();
drop function if exists integr8_purging(uuid);
drop function if exists record_submission_change();
drop function if exists record_submission_file_uses();
drop function if exists record_submitted_after_close();
drop function if exists reject_form_versions_truncate();
drop function if exists reject_published_form_version_change();
drop function if exists reject_submission_events_mutation();
drop function if exists submission_action_results_guard();
drop function if exists submission_answer_file_ids(jsonb);
drop function if exists submission_links_guard();

-- 0076 — a submission's own name, chosen at the submit step.
--
-- Until now every submission was listed under its form's title, so a company
-- filling the same form fifty times had fifty rows called "Boiler service".
-- The person submitting may now name it ("Boiler service, Nasr City villa").
-- Null keeps the old behaviour: the screens show the form's title.
--
-- Written by the submit itself (a first submit or a correction), which the
-- lifecycle trigger already allows. Expand-only: the previous release never
-- reads or writes the column.

alter table submissions
  add column title text,
  add constraint submissions_title_length
    check (title is null or char_length(btrim(title)) between 1 and 200);

comment on column submissions.title is
  'The name the person gave it when submitting (0076). Null shows the form''s title.';

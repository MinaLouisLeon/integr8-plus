-- No plan deletes a company's files on its own (P16).
--
-- 0016 seeded a retention window on three plans: 90 days on trial, 365 on
-- starter and 730 on standard. New companies start on trial, so the nightly
-- metering run would soft-delete every photo, signature and issued PDF older
-- than 90 days, the company's logo with them, and a correction to an old
-- submission would then fail because its photos were gone. The media docs and
-- the metering code both say a window starts empty and nothing is deleted
-- until somebody sets one; this makes that true.
--
-- Only a window still holding its 0016 value is cleared, so one somebody set
-- on purpose from the dashboard stays as it is.

update plan_allowances
   set retention_days = null
 where (plan, retention_days) in (('trial', 90), ('starter', 365), ('standard', 730));

# Who holds what: the permission table

Every permission (rows) against every built-in role (columns), with an explicit
`yes` or `no` in every cell. It is the reviewed copy of the matrix in
`permissions.ts`: `permissions.test.ts` fails when a cell here disagrees with
the matrix, when a permission or role is missing or extra, or when the
**Staff only** column disagrees with `STAFF_ONLY_PERMISSIONS`. A change to who
may do what therefore shows up twice in a diff, once in code and once here,
where it can be read across.

**Staff only** = `yes`: the role's seat reaches this only when Integr8 staff
sit in it (an audited impersonation grant); the company's own people never do,
however senior. The role columns are the ceiling either way.

**Adding a permission:** add it to `PERMISSIONS` and the roles that hold it in
`permissions.ts`, then add one row here in the same place, `yes` or `no` for
each of the seven roles and for **Staff only**. Grants (`GRANT_PERMISSIONS`)
and the company's own roles build on these cells and are tested separately.

| Permission               | owner | admin | hr_manager | inventory_manager | dispatcher | engineer | viewer | Staff only |
| ------------------------ | ----- | ----- | ---------- | ----------------- | ---------- | -------- | ------ | ---------- |
| `tenant.read`            | yes   | yes   | yes        | yes               | yes        | yes      | yes    | no         |
| `tenant.update`          | yes   | no    | no         | no                | no         | no       | no     | no         |
| `website.access.manage`  | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `branding.manage`        | yes   | no    | no         | no                | no         | no       | no     | yes        |
| `member.read`            | yes   | yes   | yes        | yes               | yes        | yes      | yes    | no         |
| `member.invite`          | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `member.update_role`     | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `member.suspend`         | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `member.remove`          | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `invitation.read`        | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `invitation.revoke`      | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `session.read`           | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `session.revoke`         | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `audit.read`             | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `form.read`              | yes   | yes   | yes        | yes               | yes        | yes      | yes    | no         |
| `form.manage`            | yes   | yes   | no         | no                | no         | no       | no     | yes        |
| `submission.fill`        | yes   | yes   | no         | no                | yes        | yes      | no     | no         |
| `submission.read_all`    | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `submission.amend`       | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `storage.read`           | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `customer.read`          | yes   | yes   | no         | yes               | yes        | yes      | yes    | no         |
| `customer.manage`        | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `job_type.manage`        | yes   | yes   | no         | no                | no         | no       | no     | yes        |
| `work_order.read_all`    | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `work_order.manage`      | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `work_order.progress`    | yes   | yes   | no         | no                | yes        | yes      | no     | no         |
| `work_order.review`      | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `import.run`             | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `billing.read`           | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `billing.manage`         | yes   | no    | no         | no                | no         | no       | no     | no         |
| `role.manage`            | yes   | no    | no         | no                | no         | no       | no     | no         |
| `crm.read`               | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `crm.lead.manage`        | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `crm.lead.convert`       | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `crm.opportunity.manage` | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `crm.activity.manage`    | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `crm.pipeline.manage`    | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `inventory.read`         | yes   | yes   | no         | yes               | yes        | yes      | yes    | no         |
| `inventory.manage`       | yes   | yes   | no         | yes               | yes        | no       | no     | no         |
| `inventory.move`         | yes   | yes   | no         | yes               | yes        | no       | no     | no         |
| `inventory.consume`      | yes   | yes   | no         | yes               | yes        | yes      | no     | no         |
| `purchasing.read`        | yes   | yes   | no         | yes               | yes        | no       | yes    | no         |
| `purchasing.manage`      | yes   | yes   | no         | yes               | yes        | no       | no     | no         |
| `purchasing.approve`     | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `sales.read`             | yes   | yes   | no         | yes               | yes        | no       | yes    | no         |
| `sales.manage`           | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `sales.issue`            | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `finance.read`           | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `finance.manage`         | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `finance.issue`          | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `asset.read`             | yes   | yes   | no         | no                | yes        | yes      | yes    | no         |
| `asset.record`           | yes   | yes   | no         | no                | yes        | yes      | no     | no         |
| `asset.manage`           | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `ledger.read`            | yes   | yes   | no         | no                | no         | no       | yes    | no         |
| `ledger.post`            | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `ledger.manage`          | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `ledger.unlock`          | yes   | no    | no         | no                | no         | no       | no     | no         |
| `hr.read`                | yes   | yes   | yes        | no                | no         | no       | no     | no         |
| `hr.sensitive`           | yes   | no    | yes        | no                | no         | no       | no     | no         |
| `hr.manage`              | yes   | no    | yes        | no                | no         | no       | no     | no         |
| `expense.submit`         | yes   | yes   | yes        | yes               | yes        | yes      | yes    | no         |
| `expense.approve`        | yes   | yes   | yes        | no                | no         | no       | no     | no         |
| `payroll.run`            | yes   | no    | yes        | no                | no         | no       | no     | no         |
| `payroll.approve`        | yes   | no    | yes        | no                | no         | no       | no     | no         |
| `qualification.read`     | yes   | yes   | yes        | no                | yes        | no       | yes    | no         |
| `qualification.manage`   | yes   | yes   | yes        | no                | no         | no       | no     | no         |
| `contract.read`          | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `contract.manage`        | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `deadline.manage`        | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `manufacturing.read`     | yes   | yes   | no         | yes               | no         | no       | yes    | no         |
| `manufacturing.manage`   | yes   | yes   | no         | yes               | no         | no       | no     | no         |
| `document.read`          | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `document.create`        | yes   | yes   | no         | no                | yes        | yes      | no     | no         |
| `document.manage`        | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `document.design`        | yes   | yes   | no         | no                | no         | no       | no     | yes        |
| `eta.read`               | yes   | yes   | no         | no                | yes        | no       | yes    | no         |
| `eta.prepare`            | yes   | yes   | no         | no                | yes        | no       | no     | no         |
| `eta.configure`          | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `eta.sign`               | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `eta.submit`             | yes   | yes   | no         | no                | no         | no       | no     | no         |
| `eta.switch`             | yes   | no    | no         | no                | no         | no       | no     | yes        |

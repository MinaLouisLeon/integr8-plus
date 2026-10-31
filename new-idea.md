# New feature ideas

**Recorded:** 2026-10-26

**Status:** Saved for selection and discussion. No idea below is approved for implementation.

These proposals focus on the desktop and mobile apps. Some extend existing modules. The company website is outside the scope of this list. Keep the numbers stable so an idea can be selected by number.

## 1. Recurring maintenance plans

Automatically create regular service jobs for equipment. Office staff manage plans, service frequency, and required forms on desktop. Engineers complete the visits on mobile. Show upcoming, completed, and overdue maintenance.

**Example:** Create an air-conditioning service job every three months without the dispatcher recreating it manually.

## 2. Visual scheduling board - done

Plan engineers' days on a daily or weekly calendar. Dispatchers move appointments between times or engineers and see warnings for overlapping assignments or work outside working hours. Engineers see their visit timeline on mobile, with changes received through the existing sync.

**Example:** Redistribute an unavailable engineer's remaining jobs from one desktop screen.

## 3. Team conversations inside jobs

Let engineers and office staff exchange messages, photos, and voice notes attached to a specific job. Keep decisions and instructions with the job record, accessible from desktop and mobile.

**Example:** An engineer sends a photo of an unexpected fault, and the office replies with instructions in the same job conversation.

## 4. Daily route planning

Suggest a practical order for an engineer's visits based on locations and appointment times. Show the route on mobile and let dispatchers adjust it from desktop.

**Example:** Arrange a day's visits to reduce unnecessary travel while respecting appointment windows.

## 5. Engineer skills and certificates

Record qualifications, certificates, and expiry dates. Warn when assigning work to someone without the required qualification. Make relevant qualification information available to managers and engineers in the apps.

**Example:** Warn a dispatcher before assigning an electrical inspection to an engineer whose required certificate has expired.

## 6. Leave requests and availability

Let employees request leave from mobile and managers approve it on desktop. Show approved absences when assigning jobs.

**Example:** An engineer requests two days off, and the approved absence appears in the dispatcher's availability view.

## 7. Service contracts

Track customer agreements, covered equipment, included visits, expiry dates, and work that requires an extra charge. Office staff manage contracts on desktop, and engineers see coverage on mobile before starting work.

**Example:** Show whether a repair is included in the customer's annual service agreement or needs a separate quote.

## 8. Response deadlines and escalation

Set response rules for jobs, display countdowns, and alert managers when deadlines approach or are missed. Make the relevant deadlines visible to dispatchers on desktop and engineers on mobile.

**Example:** Require urgent jobs to be attended within two hours and notify the manager before that deadline is missed.

## 9. Configurable approval rules

Extend existing approval workflows with company-defined rules. Route actions such as large discounts or expensive purchases to the required manager, with requests and decisions available in the apps according to permissions.

**Example:** Require a manager's approval before applying a discount above the company's chosen limit.

## 10. Tool checkout and returns

Track who has each company tool. Staff scan tools when collecting or returning them and report damage or loss from mobile. Office staff monitor custody and outstanding returns on desktop.

**Example:** Record which engineer collected a testing instrument and whether it was returned in good condition.

## 11. Incident reporting and corrective actions

Let employees report accidents, hazards, or equipment damage from mobile. Managers investigate on desktop, assign corrective actions, and track them through completion.

**Example:** An engineer reports unsafe wiring, and the manager assigns a corrective action with an owner and due date.

## 12. Receipt scanning for expenses

Extend existing expense claims by extracting suggested merchant, date, amount, and tax details from a photographed receipt. The employee checks the suggestions before submitting the claim for the existing review workflow.

**Example:** Photograph a fuel receipt on mobile and confirm the suggested expense details instead of typing everything manually.

## 13. Vehicle and fleet management

Track company vehicles, drivers, mileage, fuel, inspections, and service dates. Drivers submit daily checks from mobile, and office staff manage the fleet on desktop.

**Example:** A driver reports a tyre issue during a daily check, and the office schedules the vehicle for maintenance.

## 14. Return visits and rework tracking

Link a return visit to its original job, record why it was needed, and track the additional cost. Engineers capture follow-up findings on mobile, and managers review repeated faults or training needs on desktop.

**Example:** Link a second visit for the same fault to the original repair and identify the reason and extra labour or parts used.

## Selection and next steps

- **Selected idea:** 2. Visual scheduling board (2026-10-26).
- **Discussion:** Agreed: several visits per job, each with its own times and crew members; a calendar (day, week, month) rather than engineer columns; the same engineer on two jobs at once is refused, overlapping visits of the same job are allowed, and work outside office hours is always accepted; a visit is planned, done or cancelled; desktop only. Recorded in `plan/v1.2-scheduling/P25-calendar-and-dispatch-board.md`.
- **Implementation:** In progress on the `feat/visual-scheduling-board` branch.

- **Selected idea:** 5. Engineer skills and certificates (2026-10-27).
- **Discussion:** Agreed: qualifications belong to the company member, not the HR profile, so they work without the HR module; a skill has no expiry, and a certificate has dates, a number and an optional scan; owners, admins and HR managers manage them, and dispatchers and engineers read them; job types list required qualifications, copied to each job and editable there; at least one person on each visit must hold each one, valid on the visit's date; missing or expired qualifications warn, and the dispatcher must give a reason to go ahead, recorded in the job history; expiry alerts go to managers and the engineer, with a warning period each company sets (30 days by default); mobile is view only; no overrides report for now. Working hours, leave, map and travel time were moved out of P26 to ideas 6 and 4. Recorded in `plan/v1.2-scheduling/P26-skills-and-certificates.md`.
- **Implementation:** In progress on the `feat/engineer-qualifications` branch.

- **Selected ideas:** 1. Recurring maintenance plans, 7. Service contracts and 8. Response deadlines and escalation, together (2026-10-27).
- **Discussion:** Agreed: only these three; reminders before a visit, follow-up jobs and the capacity view move to a later phase, and customer self-booking is dropped; a maintenance plan belongs to one asset (so it needs the assets module); each plan counts either on a fixed calendar or from the last completion; jobs are created a set number of days ahead, unplanned, with a due window; plans at one site may share a job, switchable per plan; a contract marks each job covered or chargeable, with no automatic billing, and is renewed by hand after a reminder; deadlines are company-wide per priority, counted around the clock or in working hours per rule, met by dispatch and by completion, and never paused. Recorded in `plan/v1.2-scheduling/P27-maintenance-contracts-and-deadlines.md`.
- **Implementation:** In progress on the `feat/maintenance-contracts-deadlines` branch.

The initial suggested shortlist was **3. Team conversations inside jobs**, **8. Response deadlines and escalation**, and **5. Engineer skills and certificates**, because they fit the existing job workflow. This is a recommendation, not an approved priority order.

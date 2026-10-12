# ADR-0011 — Manufacturing: bills of materials, assembly and planning

**Status:** Accepted (seventh round planning, 2026-10-12)

## Context

The plan defers ERP-10 (manufacturing and complex supply chain) until demand
justifies the upkeep. On 2026-10-12 the product owner authorized it together
with ERP-09 (ADR-0010) and chose bills of materials, assembly orders and
material planning (MRP), without production routing or work centres.

A field-service company builds kits and assemblies from parts it stocks (a
pump set, a control panel, a service kit) before taking them to a job.
Inventory already has a catalogue, locations, an immutable stock ledger with
weighted average cost (ADR-0003), purchasing with approval, reorder levels,
and sales orders that reserve stock (ADR-0006); the general ledger posts
stock automatically (ADR-0009).

## Decision — access

- The `manufacturing` feature flag, off until Integr8 switches it on; it
  needs `inventory`.
- Owners, admins and inventory managers (the new role, or the grant on top of
  any role; ADR-0010) keep bills of materials, run assembly orders and run
  planning. Viewers read. Dispatchers keep today's inventory access and get no
  manufacturing unless granted. Engineers see nothing new.

## Decision — bills of materials

- A stock item can have a bill of materials: its components (stock or
  non-stock items) with a quantity per unit, and an optional labour and
  overhead cost per unit. Bills are versioned: editing an active bill makes a
  new version; an assembly order keeps the version it used.
- A component cannot be the item itself or contain it, however deep
  (checked when a version is saved).

## Decision — assembly and disassembly orders

- An assembly order builds N units of an item at a location from its active
  bill. It is drafted, then completed (or cancelled). Before completing, it
  shows each component's need against what is available at that location
  (on hand less reservations); completing with a shortage is refused and the
  stock never goes negative.
- Completing posts, together in one stock posting: each component out of the
  location (`assembly_consumption`) at its weighted average cost, and the
  finished units in (`assembly_output`) at the sum of the components' cost
  plus the bill's labour and overhead, which become part of the item's
  weighted average cost.
- A disassembly order takes N units of an item apart into its components at
  the item's current cost, split across the components in proportion to their
  current costs.
- Orders are numbered (`AO-000001`), never change once completed, and are
  idempotent on completion.

## Decision — planning (MRP)

- Planning runs on demand, for a horizon the person chooses. From confirmed
  sales orders not yet delivered, open assembly orders, reorder levels, stock
  on hand and reserved, and purchase orders on order, it explodes bills of
  materials level by level and lists, per item: what is needed, by when, what
  is already covered, and a suggestion to build (an item with a bill) or to
  buy (an item without), with dates from the item's or supplier's lead time.
- On request it drafts assembly orders and purchase orders (grouped by the
  item's preferred supplier) from the chosen suggestions. Purchase orders
  still go through the usual approval; nothing is sent or received
  automatically.
- A plan is a snapshot kept with who ran it and when; it is not a schedule.

## Decision — the ledger

A completed assembly or disassembly posts with the stock switch of ADR-0009:
inventory (finished item) against inventory (components), with the labour and
overhead credited to "assembly labour and overhead absorbed". No routing, work
centres, scrap or by-products in this round.

## Consequences

Assembled items take the cost of what went into them, so job costs and the
ledger stay consistent. Planning is only as good as lead times and reorder
levels; the screens say what each suggestion is based on. Routing, work
centres, capacity planning, scrap, by-products and landed costs remain
deferred.

## As built (M1)

- **Stock and cost.** Completing an order writes its movements with the
  order's id as their posting and `assembly:<order>:<item>` source keys, so a
  retried completion moves nothing twice; a completed order asked to
  complete again answers as it is. Availability at the location is on hand
  less what sales orders reserve there. Non-stock components are not moved:
  an assembly counts them at their default cost (with labour and overhead),
  and a disassembly gives nothing back for them.
- **Ledger.** Assembly movements are captured as one `assembly` document per
  order, never as `stock`: inventory rises by the labour, overhead and
  non-stock parts an assembly adds, credited to "assembly labour and overhead
  absorbed" (5300); a disassembly moves value within inventory, any rounding
  absorbed the same way.
- **Planning.** Items gain `lead_time_days` (the preferred supplier's lead
  time is used for an item bought when it has none). Sales orders carry no
  delivery date, so their outstanding quantities are needed today. Stock at
  customers' sites is not counted; purchase orders count once approved.
  Draft assembly orders count both ways (their parts as demand, their output
  as supply). A suggestion stores what it rests on (sales, assembly and
  parent demand, and how many days late its start already is). Drafted
  purchase orders go one per preferred supplier at the item's default cost
  (its average cost when none), delivered to the chosen location.

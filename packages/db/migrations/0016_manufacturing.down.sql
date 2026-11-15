-- Removes the manufacturing module (see the up file).

drop table if exists
  erp_mrp_suggestions,
  erp_assembly_orders,
  erp_mrp_plans,
  assembly_reference_counters,
  erp_bom_components,
  erp_boms
cascade;
drop function if exists assign_assembly_reference();
drop function if exists erp_assembly_orders_guard();
drop function if exists erp_bom_components_guard();
drop function if exists erp_boms_guard();
drop function if exists erp_mrp_suggestions_guard();

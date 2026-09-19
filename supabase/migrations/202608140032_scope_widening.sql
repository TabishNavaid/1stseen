-- Product scope widened 2026-09-16 (docs/role-scope.md, scope classifier v3).
--
-- Every engineering discipline counts when the role is early-career, and technical apprenticeships are an early-career
-- type. Adding enum values changes no row; `firstseen classify-roles --all` reclassifies with the v3 rules.

alter type public.role_discipline add value if not exists 'mechanical_engineering';
alter type public.role_discipline add value if not exists 'aerospace_engineering';
alter type public.role_discipline add value if not exists 'manufacturing_engineering';
alter type public.role_discipline add value if not exists 'materials_engineering';
alter type public.role_discipline add value if not exists 'chemical_engineering';
alter type public.role_discipline add value if not exists 'civil_engineering';
alter type public.role_discipline add value if not exists 'biomedical_engineering';

alter type public.early_career_type add value if not exists 'apprenticeship';

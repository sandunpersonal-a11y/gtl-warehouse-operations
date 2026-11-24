begin;
create or replace function gtl_access.can_edit_costing()
returns boolean language sql stable security definer set search_path=''
as $$
  select auth.uid() is not null and (
    lower(coalesce(auth.jwt()->>'email','')) = 'sandunpersonal@gmail.com'
    or exists(select 1 from gtl_access.user_roles
              where user_id=auth.uid() and role in ('management','payroll_admin'))
  )
$$;
revoke all on function gtl_access.can_edit_costing() from public, anon, authenticated;

create or replace function public.gtl_monthly_payroll(payroll_month text, epfs text[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  account text := lower(coalesce(auth.jwt()->>'email',''));
  admin boolean := gtl_access.can_edit_costing();
  answer jsonb;
begin
  if auth.uid() is null or (not admin and not exists(
    select 1 from gtl_payroll_private.viewers where email = account
  )) then
    raise exception 'This account has no payroll access.' using errcode = '42501';
  end if;
  select jsonb_build_object('hours', m.hours, 'revision', m.revision, 'last_upload', m.last_upload, 'records',
    coalesce((select jsonb_agg(jsonb_build_array(e.key,e.value))
      from jsonb_each(m.records) e where admin or e.key = any(epfs)), '[]'::jsonb))
  into answer from gtl_payroll_private.monthly_payroll m where m.month = payroll_month;
  return coalesce(answer, '{"hours":null,"revision":null,"records":[]}'::jsonb);
end;
$$;

create or replace function public.gtl_save_monthly_payroll(
  payroll_month text, records jsonb, paid_hours numeric, totals jsonb, expected_revision bigint
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not gtl_access.can_edit_costing() then
    raise exception 'Management or payroll administrator access is required.' using errcode = '42501';
  end if;
  if payroll_month is null or payroll_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or jsonb_typeof(records) is distinct from 'object' or octet_length(records::text) > 3000000
     or paid_hours is null or paid_hours <= 0 or paid_hours > 744
     or jsonb_typeof(totals) is distinct from 'array' or octet_length(totals::text) > 3000000 then
    raise exception 'Invalid month, payroll or paid hours.';
  end if;
  if exists (select 1 from jsonb_each(records) e where e.key !~ '^[0-9]+$'
    or jsonb_typeof(e.value->'basic') is distinct from 'number'
    or jsonb_typeof(e.value->'allowance') is distinct from 'number'
    or jsonb_typeof(e.value->'regularPay') is distinct from 'number'
    or (e.value->>'basic')::numeric < 0 or (e.value->>'regularPay')::numeric < 0) then
    raise exception 'Invalid EPF or payroll amount.';
  end if;
  if expected_revision is null then
    insert into gtl_payroll_private.monthly_payroll (month,records,hours,totals,revision)
      values (payroll_month,records,paid_hours,totals,1) on conflict (month) do nothing;
  else
    update gtl_payroll_private.monthly_payroll m
      set records = gtl_save_monthly_payroll.records, hours = paid_hours,
          totals = gtl_save_monthly_payroll.totals, revision = m.revision + 1
      where m.month = payroll_month and m.revision = expected_revision;
  end if;
  if not found then
    raise exception 'Payroll for this month changed. Refresh shared payroll and retry.';
  end if;
end;
$$;

create or replace function public.gtl_upload_monthly_payroll_file(
  payroll_month text, records jsonb, paid_hours numeric, totals jsonb, expected_revision bigint
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> 'sandunpersonal@gmail.com' then
    raise exception 'Only the payroll administrator can upload payroll files.' using errcode='42501';
  end if;
  perform public.gtl_save_monthly_payroll(payroll_month, records, paid_hours, totals, expected_revision);
  update gtl_payroll_private.monthly_payroll m
    set last_upload = clock_timestamp()
    where m.month = payroll_month;
end;
$$;

create or replace function public.gtl_private_movement_crews(period text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not gtl_access.can_edit_costing() then
    raise exception 'Management or payroll administrator access is required.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id',o->>'id','operators',o->'operators',
      'tally',o->'tally','supervisors',o->'supervisors'))
    from gtl_payroll_private.movement_operations m
    cross join lateral (select m.operation as o) data
    where left(o->>'start',7)=period
  ),'[]'::jsonb);
end;
$$;

create or replace function public.gtl_publish_job_costs(p_customer text,p_job text,p_costs jsonb)
returns void language plpgsql security definer set search_path=''
as $$
declare category text;
declare entries jsonb;
declare allowed jsonb := '{}'::jsonb;
declare loading numeric;
declare unloading numeric;
begin
  if not gtl_access.can_edit_costing() then
    raise exception 'Management or payroll administrator access is required.' using errcode='42501';
  end if;
  if nullif(trim(p_customer),'') is null or nullif(trim(p_job),'') is null
    or jsonb_typeof(p_costs) is distinct from 'object' or octet_length(p_costs::text)>1000000 then
    raise exception 'Invalid job or cost data.';
  end if;
  loading := (p_costs->>'load')::numeric;
  unloading := (p_costs->>'unload')::numeric;
  if loading<0 or unloading<0 then raise exception 'Invalid area rate.'; end if;
  foreach category in array array['storage','equipment','consumables','vas','thirdParty'] loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'U',e."U",'L',e."L",'UL',e."UL",'date',e.date,'periodEnd',e."periodEnd",'quantity',e.quantity,'vehicle',e.vehicle,
      'item',e.item,'unit',e.unit,'notes',e.notes,'month',e.month,'currency',e.currency,'originalRate',e."originalRate",'fx',e.fx
    )), '[]'::jsonb) into entries
    from jsonb_to_recordset(coalesce(p_costs->'chargeEntries'->category,'[]'::jsonb))
      as e("U" numeric,"L" numeric,"UL" numeric,date date,"periodEnd" date,quantity numeric,vehicle text,item text,unit text,notes text,month text,currency text,"originalRate" numeric,fx jsonb)
    where coalesce(e."U",0)>=0 and coalesce(e."L",0)>=0 and e.quantity>0
      and (e."UL" is null or (e."UL">=0 and e."U" is null and e."L" is null));
    allowed := jsonb_set(allowed,array[category],entries);
  end loop;
  insert into gtl_payroll_private.published_job_costs(customer,job,costs)
  values(p_customer,p_job,jsonb_build_object('load',loading,'unload',unloading,'chargeEntries',allowed))
  on conflict(customer,job) do update set costs=excluded.costs;
end;
$$;
revoke execute on function public.gtl_monthly_payroll(text,text[]), public.gtl_save_monthly_payroll(text,jsonb,numeric,jsonb,bigint), public.gtl_upload_monthly_payroll_file(text,jsonb,numeric,jsonb,bigint), public.gtl_private_movement_crews(text), public.gtl_publish_job_costs(text,text,jsonb) from public, anon;
grant execute on function public.gtl_monthly_payroll(text,text[]), public.gtl_save_monthly_payroll(text,jsonb,numeric,jsonb,bigint), public.gtl_upload_monthly_payroll_file(text,jsonb,numeric,jsonb,bigint), public.gtl_private_movement_crews(text), public.gtl_publish_job_costs(text,text,jsonb) to authenticated;
create or replace function public.gtl_staff_job_costs()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not gtl_access.can_edit_costing() then
    raise exception 'Management or payroll administrator access is required.' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('customer',p.customer,'job',p.job,'costs',p.costs)), '[]'::jsonb)
    from gtl_payroll_private.published_job_costs p);
end;
$$;
revoke all on function public.gtl_staff_job_costs() from public, anon;
grant execute on function public.gtl_staff_job_costs() to authenticated;

-- Keep staff charge descriptions and notes out of the existing public response.
create or replace function public.gtl_public_job_costs()
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'customer',p.customer,'job',p.job,'costs',jsonb_build_object(
      'load',p.costs->'load','unload',p.costs->'unload',
      'chargeEntries',coalesce((
        select jsonb_object_agg(category,items)
        from (
          select c.key as category,
            coalesce((select jsonb_agg(jsonb_build_object(
              'U',e->'U','L',e->'L','UL',e->'UL','date',e->'date','periodEnd',e->'periodEnd',
              'quantity',e->'quantity','vehicle',e->'vehicle') order by n)
              from jsonb_array_elements(c.value) with ordinality as x(e,n)),'[]'::jsonb) as items
          from jsonb_each(coalesce(p.costs->'chargeEntries','{}'::jsonb)) as c
          where jsonb_typeof(c.value)='array'
        ) as categories
      ),'{}'::jsonb)
    ))), '[]'::jsonb)
  from gtl_payroll_private.published_job_costs p
$$;

notify pgrst, 'reload schema';
commit;

const payrollConnection=[
  'https://grwpirvruekocuydrjhn.supabase.co',
  'sb_publishable_4CS6L84JSXxjm1TPUJWbCQ_ZwUwjzTm',
];
const labourClient = window.supabase?.createClient(...payrollConnection, {
  auth:{storageKey:'gtl-payroll-auth',storage:{
    getItem:key=>sessionStorage.getItem(key)??localStorage.getItem(key),
    setItem:(key,value)=>(localStorage.getItem('gtl-staff-remember')==='0'?sessionStorage:localStorage).setItem(key,value),
    removeItem:key=>{sessionStorage.removeItem(key);localStorage.removeItem(key);}
  },detectSessionInUrl:false}
});

async function labourRole() {
  if (!labourClient) return '';
  const { data:{session} } = await labourClient.auth.getSession();
  if (!session) return '';
  const { data, error } = await labourClient.rpc('gtl_dashboard_role');
  if (error) throw error;
  return ['management','payroll_admin'].includes(data) ? data : '';
}

async function loadLabourMonth(month) {
  const [upload, rates] = await Promise.all([
    labourClient.from('gtl_labour_months').select('operations,updated_at,source_name').eq('month',month).maybeSingle(),
    labourClient.from('gtl_labour_agency_rates').select('agent,vehicle_type,direction,amount').eq('month',month)
  ]);
  if (upload.error) throw upload.error;
  if (rates.error) throw rates.error;
  return {upload:upload.data,rates:rates.data};
}

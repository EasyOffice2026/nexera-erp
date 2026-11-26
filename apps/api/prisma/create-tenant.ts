import { runProvision } from './provision';

const [slug, tenant, email, fullName, en, ar, cr, year] = process.argv.slice(2);
await runProvision({
  slug,
  tenant,
  owner: { email, fullName, password: process.env.NEXERA_OWNER_PASSWORD, role: 'owner' },
  companies: [{ en, ar, cr }],
  year: year ?? new Date().getFullYear(),
});

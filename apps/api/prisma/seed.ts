import { runProvision } from './provision';

if (process.env.NODE_ENV === 'production') {
  console.error('Demo provisioning is disabled in production.');
  process.exitCode = 1;
} else {
  await runProvision({
    slug: 'easyoffice',
    tenant: 'EasyOffice Demo',
    owner: {
      email: 'owner@example.com',
      fullName: 'Nexera Finance',
      password: process.env.NEXERA_OWNER_PASSWORD,
      role: 'owner',
    },
    companies: [
      { en: 'Mudawwarah', ar: 'مدورة', cr: 'DEMO-001' },
      { en: 'Khubuz Maraei', ar: 'خبز مراعي', cr: 'DEMO-002' },
    ],
    year: new Date().getFullYear(),
  });
}

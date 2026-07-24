/**
 * Seeds demo accounts and a realistic pipeline.
 * Idempotent: re-running skips accounts that already exist.
 * Pass --reset to wipe leads, notes and activity first.
 */
import { getDb, q, nowIso } from '../src/lib/db.js';
import { createUser, findUserByEmail } from '../src/domain/users.js';
import { createLead, updateLead, assignLead, addNote } from '../src/domain/leads.js';

const ACCOUNTS = [
  { email: 'admin@pipeline.test', name: 'Dana Whitfield', role: 'admin', password: 'AdminPass!2026' },
  { email: 'rosa@pipeline.test', name: 'Rosa Iyer', role: 'member', password: 'MemberPass!2026' },
  { email: 'kwame@pipeline.test', name: 'Kwame Osei', role: 'member', password: 'MemberPass!2026' },
];

const SAMPLE_LEADS = [
  { name: 'Priya Raman', email: 'priya@northgate.io', company: 'Northgate Logistics', phone: '+1 415 555 0142', message: 'We run 40 trucks and track everything in spreadsheets. Looking for something our dispatchers will actually open.', valueCents: 480000, owner: 1, advanceTo: 'qualified' },
  { name: 'Tom Beckett', email: 'tom@harborworks.com', company: 'Harborworks', phone: '+1 617 555 0119', message: 'Renewal coming up in March. Want to compare options before we commit.', valueCents: 1250000, owner: 1, advanceTo: 'proposal' },
  { name: 'Lena Fischer', email: 'l.fischer@meridian-labs.de', company: 'Meridian Labs', message: 'Need role-based access for a 12-person team. Is that on the roadmap?', valueCents: 320000, owner: 2, advanceTo: 'contacted' },
  { name: 'Marcus Hale', email: 'marcus@bellwether.co', company: 'Bellwether Co', phone: '+44 20 7946 0958', message: 'Budget approved, timeline is tight.', valueCents: 890000, owner: 2, advanceTo: 'won' },
  { name: 'Aisha Nkemelu', email: 'aisha@crestpoint.org', company: 'Crestpoint Foundation', message: 'Grant-funded, so we need pricing for nonprofits.', valueCents: 150000, owner: 1, advanceTo: 'lost' },
  { name: 'Diego Marquez', email: 'diego@saltflat.studio', company: 'Saltflat Studio', message: 'Small team, five seats. How fast can we be up?', valueCents: 90000, owner: null, advanceTo: null },
  { name: 'Yuki Tanaka', email: 'yuki@orchid-supply.jp', company: 'Orchid Supply', phone: '+81 3 5555 0187', message: 'Evaluating three vendors this quarter.', valueCents: 600000, owner: null, advanceTo: null },
  { name: 'Sam Oduya', email: 'sam@fieldnote.app', company: 'Fieldnote', message: 'Came from the webinar. Want a walkthrough.', valueCents: null, owner: 2, advanceTo: 'contacted' },
];

const NOTES = {
  1: ['Left a voicemail and followed up by email.', 'Spoke for 20 minutes. Dispatchers are the real users — 6 of them. Pricing sensitive but the pain is real.'],
  2: ['Renewal date confirmed: 14 March. Sent the comparison sheet.', 'Proposal drafted, waiting on their procurement to name a signer.'],
  4: ['Fast mover. Contract signed on the second call.'],
  5: ['Went with a cheaper option. Worth revisiting when their grant renews.'],
};

const PATH = { contacted: ['contacted'], qualified: ['contacted', 'qualified'], proposal: ['contacted', 'qualified', 'proposal'], won: ['contacted', 'qualified', 'proposal', 'won'], lost: ['contacted', 'lost'] };

function main() {
  getDb();
  const reset = process.argv.includes('--reset');
  if (reset) {
    q.run('DELETE FROM activities');
    q.run('DELETE FROM notes');
    q.run('DELETE FROM leads');
    console.log('Cleared leads, notes and activity.');
  }

  const users = ACCOUNTS.map((account) => {
    const existing = findUserByEmail(account.email);
    if (existing) {
      console.log(`· ${account.email} already exists`);
      return { id: existing.id, name: existing.name, role: existing.role };
    }
    const created = createUser(account);
    console.log(`+ ${account.email} (${account.role})`);
    return created;
  });

  const admin = users[0];
  const members = [users[1], users[2]];

  if (q.get('SELECT COUNT(*) AS n FROM leads').n > 0) {
    console.log('Leads already present — skipping sample data. Use --reset to rebuild.');
    return;
  }

  for (const sample of SAMPLE_LEADS) {
    const lead = createLead(
      {
        name: sample.name,
        email: sample.email,
        phone: sample.phone ?? null,
        company: sample.company,
        message: sample.message,
        valueCents: sample.valueCents,
      },
      null,
    );

    let current = lead;
    if (sample.owner) {
      const owner = members[sample.owner - 1];
      current = assignLead(current, owner.id, admin);
      for (const step of PATH[sample.advanceTo] || []) {
        current = updateLead(current, { status: step }, owner);
      }
      for (const body of NOTES[lead.id] || []) {
        addNote(lead.id, body, owner);
      }
    }
  }

  // Backdate creation so the list is not all one timestamp.
  const rows = q.all('SELECT id FROM leads ORDER BY id');
  rows.forEach((row, i) => {
    const ts = new Date(Date.now() - (rows.length - i) * 26 * 3600 * 1000).toISOString();
    q.run('UPDATE leads SET created_at = ? WHERE id = ?', [ts, row.id]);
  });

  console.log(`\nSeeded ${rows.length} leads at ${nowIso()}`);
  console.log('\nSign in with:');
  for (const account of ACCOUNTS) {
    console.log(`  ${account.role.padEnd(6)} ${account.email}  ${account.password}`);
  }
}

main();

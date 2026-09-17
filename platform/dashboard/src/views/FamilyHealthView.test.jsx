import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import FamilyHealthView from './FamilyHealthView.jsx';

// Synthetic payloads only (ADR-0010): no real member ever appears in tests.
const summary = {
  notice: 'Data to raise with a physician, never a diagnosis.',
  overviewPresent: true,
  members: [
    {
      name: 'Ada Example',
      slug: 'ada-example',
      folder: 'members/Ada Example',
      wikiPath: 'wiki/projects/family-health-tracker/ada-example.md',
      overview: { bloodType: 'O+', keyConditions: 'Low ferritin (fixture)' },
      profileMissing: false,
      examsN: 2,
      documentsN: 1,
      medicationsN: 2,
      pendingN: 7,
      lastExamDate: '2026-03-05',
    },
    {
      name: 'Bo Example',
      slug: 'bo-example',
      folder: 'members/Bo Example',
      wikiPath: null,
      overview: { bloodType: 'A+', keyConditions: '—' },
      profileMissing: false,
      examsN: 1,
      documentsN: 1,
      medicationsN: 0,
      pendingN: 0,
      lastExamDate: '2026-01-20',
    },
  ],
  totals: { membersN: 2, examsN: 3, documentsN: 2, medicationsN: 2, openFollowUpsN: 3, flaggedN: 3, originalsMissingN: 1, pendingN: 8, lastExamDate: '2026-03-05' },
};

const pending = {
  total: 1,
  byKind: { checkbox: 1 },
  items: [
    { kind: 'checkbox', member: 'Ada Example', path: 'members/Ada Example/exams/2026-03-05_bloodwork.md', line: 20, date: '2026-03-05', text: 'Attach the original report.' },
  ],
};

const memberFile = {
  member: summary.members[0],
  profileMissing: false,
  historyMissing: false,
  profile: {
    identity: [{ key: 'Blood type', value: 'O+' }],
    allergies: [],
    conditions: ['Low ferritin — fixture condition.'],
    medications: [{ medication: 'Iron (fixture)', dose: '100 mg', frequency: 'once daily', since: '2026-02-01', prescribedFor: 'Low ferritin' }],
    careTeam: [],
    lastReviewed: '2026-03-05',
  },
  history: [{ date: '2026-03-05', title: 'Bloodwork follow-up', line: 5, fields: [] }],
  exams: [{ path: 'members/Ada Example/exams/2026-03-05_bloodwork.md', name: '2026-03-05_bloodwork.md', date: '2026-03-05', title: 'Bloodwork follow-up — Ada Example', type: 'Bloodwork', facility: 'Fixture Lab B', flaggedN: 1, openFollowUpsN: 2, originalMissing: true, hasResultsTable: true }],
  documents: [{ name: '2026-01-10_bloodwork.pdf', ext: 'pdf', size: 2048, absolutePath: '/health/members/Ada Example/documents/2026-01-10_bloodwork.pdf' }],
  markers: [{ marker: 'Ferritin', n: 2 }],
  stats: { examsN: 2, medicationsN: 2, pendingN: 7, lastExamDate: '2026-03-05' },
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function mockFetch(routes) {
  const fetchMock = vi.fn((url) => {
    for (const [prefix, response] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(response());
    }
    return Promise.resolve(json({ error: 'not-found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('FamilyHealthView', () => {
  test('unconfigured root renders the not-configured panel naming the env var', async () => {
    mockFetch([['/api/family-health/summary', () => json({ error: 'family-health-not-configured', message: 'unset' }, 404)]]);
    render(<FamilyHealthView onOpenDoc={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Not configured/)).toBeInTheDocument());
    expect(screen.getByText('HEALTH_REPO_ROOT')).toBeInTheDocument();
  });

  test('a proxied request shows the loopback-only refusal, not an empty state', async () => {
    mockFetch([['/api/family-health/summary', () => json({ error: 'family-health-proxy-refused', message: 'refused' }, 403)]]);
    render(<FamilyHealthView onOpenDoc={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Refused through the proxy hostname/)).toBeInTheDocument());
  });

  test('loaded record: notice, totals, members, pending; selecting a member loads the file and wiki link', async () => {
    const user = userEvent.setup();
    const onOpenDoc = vi.fn();
    const boFile = {
      ...memberFile,
      member: summary.members[1],
      profile: { ...memberFile.profile, medications: [] },
      stats: { examsN: 1, medicationsN: 0, pendingN: 0, lastExamDate: '2026-01-20' },
    };
    const noteFor = (name) => ({
      name: 'profile.md',
      path: `members/${name}/profile.md`,
      absolutePath: `/health/members/${name}/profile.md`,
      markdown: `# Profile — ${name}\n\nFixture note for ${name}.\n`,
      mtime: '2026-03-05T00:00:00.000Z',
    });
    const fetchMock = mockFetch([
      ['/api/family-health/summary', () => json(summary)],
      ['/api/family-health/pending', () => json(pending)],
      ['/api/family-health/member?name=Ada%20Example', () => json(memberFile)],
      ['/api/family-health/member?name=Bo%20Example', () => json(boFile)],
      ['/api/family-health/file?path=members%2FAda%20Example%2Fprofile.md', () => json(noteFor('Ada Example'))],
      ['/api/family-health/file?path=members%2FBo%20Example%2Fprofile.md', () => json(noteFor('Bo Example'))],
    ]);
    render(<FamilyHealthView onOpenDoc={onOpenDoc} />);

    await waitFor(() => expect(screen.getByTitle('members/Ada Example')).toBeInTheDocument());
    expect(screen.getByText(/never a diagnosis/)).toBeInTheDocument();
    expect(screen.getByTitle('members/Bo Example')).toBeInTheDocument();
    expect(screen.getByText('7 pending')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Attach the original report.')).toBeInTheDocument());

    await user.click(screen.getByTitle('members/Ada Example'));
    await waitFor(() => expect(screen.getByText('Iron (fixture)')).toBeInTheDocument());
    expect(screen.getByText('100 mg')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/family-health/member?name=Ada%20Example');

    await user.click(screen.getByText('wiki page'));
    expect(onOpenDoc).toHaveBeenCalledWith('wiki/projects/family-health-tracker/ada-example.md');

    await user.click(screen.getByText('Documents · 1'));
    expect(screen.getByText('2026-01-10_bloodwork.pdf')).toBeInTheDocument();
    expect(screen.getByText(/never served over HTTP/)).toBeInTheDocument();
  });

  test('the Note panel follows the selected member instead of keeping the last opened note', async () => {
    const user = userEvent.setup();
    const noteFor = (name) => ({
      name: 'profile.md',
      path: `members/${name}/profile.md`,
      absolutePath: `/health/members/${name}/profile.md`,
      markdown: `# Profile — ${name}\n\nFixture note for ${name}.\n`,
      mtime: '2026-03-05T00:00:00.000Z',
    });
    const boFile = { ...memberFile, member: summary.members[1], stats: { examsN: 1, medicationsN: 0, pendingN: 0, lastExamDate: '2026-01-20' } };
    mockFetch([
      ['/api/family-health/summary', () => json(summary)],
      ['/api/family-health/pending', () => json(pending)],
      ['/api/family-health/member?name=Ada%20Example', () => json(memberFile)],
      ['/api/family-health/member?name=Bo%20Example', () => json(boFile)],
      ['/api/family-health/file?path=members%2FAda%20Example%2Fprofile.md', () => json(noteFor('Ada Example'))],
      ['/api/family-health/file?path=members%2FBo%20Example%2Fprofile.md', () => json(noteFor('Bo Example'))],
    ]);
    render(<FamilyHealthView onOpenDoc={() => {}} />);
    await waitFor(() => expect(screen.getByTitle('members/Ada Example')).toBeInTheDocument());

    await user.click(screen.getByTitle('members/Ada Example'));
    await waitFor(() => expect(screen.getByText('Fixture note for Ada Example.')).toBeInTheDocument());

    await user.click(screen.getByTitle('members/Bo Example'));
    await waitFor(() => expect(screen.getByText('Fixture note for Bo Example.')).toBeInTheDocument());
    expect(screen.queryByText('Fixture note for Ada Example.')).not.toBeInTheDocument();
    expect(screen.getByText('members/Bo Example/profile.md')).toBeInTheDocument();
  });
});

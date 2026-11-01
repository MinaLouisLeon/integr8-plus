import { describe, expect, it } from 'vitest';

import { runMaintenanceSteps } from './maintenance-steps.js';

describe('runMaintenanceSteps', () => {
  it('runs the steps after one that fails, and says which one failed', async () => {
    const ran: string[] = [];
    const errors: { message: string; fields: Record<string, unknown> | undefined }[] = [];

    const failed = await runMaintenanceSteps(
      [
        { name: 'Media maintenance', run: () => Promise.resolve(void ran.push('media')) },
        {
          name: 'Scheduled deletions',
          run: () => Promise.reject(new Error('purge_tenant refused')),
        },
        { name: 'Deadline alerts', run: () => Promise.resolve(void ran.push('deadlines')) },
      ],
      { error: (message, fields) => errors.push({ message, fields }) },
    );

    expect(ran).toEqual(['media', 'deadlines']);
    expect(failed).toEqual(['Scheduled deletions']);
    expect(errors).toEqual([
      { message: 'Scheduled deletions failed', fields: { error: 'purge_tenant refused' } },
    ]);
  });

  it('reports nothing when every step succeeds', async () => {
    const errors: string[] = [];
    const failed = await runMaintenanceSteps(
      [{ name: 'Sync maintenance', run: () => Promise.resolve() }],
      { error: (message) => errors.push(message) },
    );
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
  });
});

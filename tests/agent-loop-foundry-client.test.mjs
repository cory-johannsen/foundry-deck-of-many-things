import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Simulate "no .env file" regardless of what's actually on disk in this repo
// (there is a real .env with a real FOUNDRY_BASE_URL checked in for local
// dev use) — this isolates the "nothing configured at all" case the throw
// below exists for.
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('ENOENT: no such file'); }
}));

const { runFoundryScript } = await import('../tools/agent-loop/foundry-client.mjs');

describe('runFoundryScript', () => {
  const originalBaseUrl = process.env.FOUNDRY_BASE_URL;
  const originalApiKey = process.env.FOUNDRY_REST_API_KEY;

  beforeEach(() => {
    delete process.env.FOUNDRY_BASE_URL;
    delete process.env.FOUNDRY_REST_API_KEY;
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.FOUNDRY_BASE_URL;
    else process.env.FOUNDRY_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete process.env.FOUNDRY_REST_API_KEY;
    else process.env.FOUNDRY_REST_API_KEY = originalApiKey;
  });

  it('throws instead of silently defaulting to the public foundryrestapi.com relay when FOUNDRY_BASE_URL is unset', async () => {
    const fetchImpl = vi.fn();
    await expect(runFoundryScript('return 1;', { apiKey: 'test-key', fetchImpl }))
      .rejects.toThrow(/FOUNDRY_BASE_URL not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still throws its own clear error when only FOUNDRY_REST_API_KEY is unset', async () => {
    const fetchImpl = vi.fn();
    await expect(runFoundryScript('return 1;', { baseUrl: 'http://localhost:9999', fetchImpl }))
      .rejects.toThrow(/FOUNDRY_REST_API_KEY not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

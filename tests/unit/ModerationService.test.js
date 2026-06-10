import { jest } from '@jest/globals';
import { GroqModerationAdapter } from '../../src/moderation/GroqModerationAdapter.js';
import { ModerationService } from '../../src/moderation/ModerationService.js';

describe('GroqModerationAdapter', () => {
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('constructor throws when apiKey is empty', () => {
    expect(() => new GroqModerationAdapter('')).toThrow();
  });

  test('check returns safe when input is clean', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'safe',
            },
          },
        ],
      }),
    });

    const adapter = new GroqModerationAdapter('fake-key');
    const result = await adapter.check('hello world');
    expect(result.safe).toBe(true);
    expect(result.flaggedCategories).toEqual([]);
  });

  test('check returns unsafe and correct categories', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'unsafe: S1,S11',
            },
          },
        ],
      }),
    });

    const adapter = new GroqModerationAdapter('fake-key');
    const result = await adapter.check('violent stuff');
    expect(result.safe).toBe(false);
    expect(result.flaggedCategories).toEqual(['violent_crimes', 'suicide_self_harm']);
  });
});

describe('ModerationService', () => {
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('uses fallback mode when groqKey is missing', async () => {
    const service = new ModerationService({ groqKey: null });
    const result = await service.check('hello world');
    expect(result.safe).toBe(true);
  });

  test('executes adapter check successfully when present', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'safe',
            },
          },
        ],
      }),
    });

    const service = new ModerationService({ groqKey: 'fake-key' });
    const result = await service.check('hello world');
    expect(result.safe).toBe(true);
  });
});

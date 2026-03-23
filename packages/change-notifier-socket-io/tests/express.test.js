import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockRunExpress = vi.fn();
vi.mock('../express.js', () => ({
  runExpress: mockRunExpress,
}));

const { express } = await import('../index.js');

describe('express', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns a function that accepts correlationConfig', () => {
    const config = { port: 3008 };
    const result = express(config);

    expect(typeof result).toBe('function');
  });

  test('calls runExpress with correlationConfig and config', () => {
    const config = { port: 3008, jwtAuth: 'secret' };
    const correlationConfig = { serviceId: 'TEST' };

    express(config)(correlationConfig);

    expect(mockRunExpress).toHaveBeenCalledWith(correlationConfig, config);
  });

  test('passes through different configs correctly', () => {
    const config1 = { port: 4000 };
    const config2 = { port: 5000, host: 'localhost' };
    const corr = { serviceId: 'SVC' };

    express(config1)(corr);
    express(config2)(corr);

    expect(mockRunExpress).toHaveBeenCalledTimes(2);
    expect(mockRunExpress).toHaveBeenNthCalledWith(1, corr, config1);
    expect(mockRunExpress).toHaveBeenNthCalledWith(2, corr, config2);
  });
});

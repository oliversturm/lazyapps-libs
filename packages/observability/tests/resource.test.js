import { describe, test, expect, vi } from 'vitest';

const mockResourceFromAttributes = vi.fn((attrs) => ({
  attributes: attrs,
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: mockResourceFromAttributes,
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

const { createResource } = await import('../resource.js');

describe('createResource', () => {
  test('creates resource with required service name', () => {
    const result = createResource({ serviceName: 'test-service' });
    expect(mockResourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'test-service',
    });
    expect(result.attributes['service.name']).toBe('test-service');
  });

  test('includes optional service version', () => {
    createResource({
      serviceName: 'test-service',
      serviceVersion: '1.0.0',
    });
    expect(mockResourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'test-service',
      'service.version': '1.0.0',
    });
  });

  test('includes optional environment', () => {
    createResource({
      serviceName: 'test-service',
      environment: 'staging',
    });
    expect(mockResourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'test-service',
      'deployment.environment.name': 'staging',
    });
  });

  test('includes all optional fields when provided', () => {
    createResource({
      serviceName: 'test-service',
      serviceVersion: '2.0.0',
      environment: 'production',
    });
    expect(mockResourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'test-service',
      'service.version': '2.0.0',
      'deployment.environment.name': 'production',
    });
  });

  test('omits version when not provided', () => {
    createResource({ serviceName: 'test-service' });
    const callArgs = mockResourceFromAttributes.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('service.version');
  });

  test('omits environment when not provided', () => {
    createResource({ serviceName: 'test-service' });
    const callArgs = mockResourceFromAttributes.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('deployment.environment.name');
  });

  test('omits version when empty string', () => {
    createResource({ serviceName: 'test-service', serviceVersion: '' });
    const callArgs = mockResourceFromAttributes.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('service.version');
  });

  test('omits environment when empty string', () => {
    createResource({ serviceName: 'test-service', environment: '' });
    const callArgs = mockResourceFromAttributes.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('deployment.environment.name');
  });

  test('uses deployment.environment.name attribute key for environment', () => {
    createResource({
      serviceName: 'test-service',
      environment: 'production',
    });
    const callArgs = mockResourceFromAttributes.mock.calls.at(-1)[0];
    expect(callArgs).toHaveProperty('deployment.environment.name', 'production');
    expect(callArgs).not.toHaveProperty('environment');
  });

  test('returns the result from resourceFromAttributes', () => {
    const result = createResource({ serviceName: 'test-service' });
    expect(result).toHaveProperty('attributes');
    expect(result.attributes['service.name']).toBe('test-service');
  });
});

import { getLogger } from '@lazyapps/logger';

const log = getLogger('Encryption/JwtScope', 'INIT');

export const directRoleMapper = () => (auth) => ({
  roles: (auth && auth.roles) || [],
  identity: auth && auth.sub,
});

export const scopeClaimMapper =
  (claimName = 'lazyAppsEncryptionScopes') =>
  (auth) => ({
    roles: (auth && auth[claimName]) || [],
    identity: auth && auth.sub,
  });

export const customMapper = (fn) => (auth) => {
  const result = fn(auth || {});
  return {
    roles: result.roles || [],
    identity: result.identity,
  };
};

log.info('JWT scope mapper module loaded');

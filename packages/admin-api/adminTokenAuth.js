const adminTokenAuth = (token) => (req, res, next) => {
  if (!token) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const validateAdminToken = (expectedToken, receivedToken) => {
  if (!expectedToken) return true;
  return receivedToken === expectedToken;
};

export { adminTokenAuth, validateAdminToken };

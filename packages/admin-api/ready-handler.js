import { getLogger } from '@lazyapps/logger';

export const setReadyHandler = (context) => (req, res) => {
  const { correlationId } = req.body;
  const log = getLogger('Admin/Ready', correlationId || 'SYS');

  log.info('CP readiness signal received');

  if (context.setReady) {
    context.setReady(true);
    log.info('Command processor is now accepting commands');
    res.json({ status: 'ready' });
  } else {
    log.warn('No setReady function on context — CP readiness not configured');
    res.json({ status: 'ready', note: 'readiness not configured' });
  }
};

export const getReadyHandler = (context) => (req, res) => {
  const isReady = context.isReady ? context.isReady() : true;
  res.json({ ready: isReady });
};

const validationError = (message) => {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
};

export const createForgetMixin = (contexts, { authorizeForget } = {}) => {
  const autoForgetContexts = Object.entries(contexts)
    .filter(([, cfg]) => cfg.autoForget)
    .map(([name]) => name);

  return {
    commands: {
      FORGET_SUBJECT: (aggregate, payload, auth) => {
        if (authorizeForget) {
          authorizeForget(aggregate, payload, auth);
        }
        const forgottenContexts = aggregate.forgottenContexts || [];
        if (
          autoForgetContexts.length &&
          autoForgetContexts.every((ctx) => forgottenContexts.includes(ctx))
        ) {
          throw validationError(
            `Subject ${payload.subjectId || 'unknown'} has already been forgotten`,
          );
        }
        if (!autoForgetContexts.length) {
          throw validationError(
            'No contexts with autoForget enabled — ' +
              'use FORGET_SUBJECT_CONTEXT for explicit context forgetting',
          );
        }
        return {
          type: 'SUBJECT_FORGOTTEN',
          payload: {
            ...payload,
            contexts: autoForgetContexts,
          },
        };
      },

      FORGET_SUBJECT_CONTEXT: (aggregate, payload, auth) => {
        if (authorizeForget) {
          authorizeForget(aggregate, payload, auth);
        }
        if (!payload.contextName) {
          throw validationError('Missing contextName in payload');
        }
        const forgottenContexts = aggregate.forgottenContexts || [];
        if (forgottenContexts.includes(payload.contextName)) {
          throw validationError(
            `Context ${payload.contextName} has already been forgotten`,
          );
        }
        return {
          type: 'SUBJECT_FORGOTTEN',
          payload: {
            ...payload,
            contexts: [payload.contextName],
          },
        };
      },
    },

    projections: {
      SUBJECT_FORGOTTEN: (aggregate, event) => {
        const existingContexts = aggregate.forgottenContexts || [];
        const newContexts = (event.payload && event.payload.contexts) || [];
        const merged = [...new Set([...existingContexts, ...newContexts])];
        return {
          ...aggregate,
          forgottenContexts: merged,
        };
      },
    },
  };
};

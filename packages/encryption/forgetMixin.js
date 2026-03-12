const validationError = (message) => {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
};

export const createForgetMixin = (contexts) => {
  const autoForgetContexts = Object.entries(contexts)
    .filter(([, cfg]) => cfg.autoForget)
    .map(([name]) => name);

  return {
    commands: {
      FORGET_SUBJECT: (aggregate, payload) => {
        if (aggregate.forgotten) {
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

      FORGET_SUBJECT_CONTEXT: (aggregate, payload) => {
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

      FORGET_RELATED_SUBJECT: (aggregate, payload) => {
        if (!payload.relatedSubjectId) {
          throw validationError('Missing relatedSubjectId in payload');
        }
        if (!payload.relatedSubjectType) {
          throw validationError('Missing relatedSubjectType in payload');
        }
        if (!payload.contexts || !payload.contexts.length) {
          throw validationError('Missing contexts in payload');
        }
        return {
          type: 'RELATED_SUBJECT_FORGOTTEN',
          payload,
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
          forgotten: true,
          forgottenContexts: merged,
          forgottenAt: event.timestamp,
        };
      },
    },
  };
};

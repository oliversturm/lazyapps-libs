const validationError = (message) => {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
};

export const subjectLifecycleAggregate = {
  initial: () => ({}),

  commands: {
    FORGET_SUBJECT: (aggregate, payload) => {
      if (!payload.subjectId) {
        throw validationError('Missing subjectId in payload');
      }
      if (aggregate.forgotten) {
        throw validationError(
          `Subject ${payload.subjectId} has already been forgotten`,
        );
      }
      return {
        type: 'SUBJECT_FORGOTTEN',
        payload,
      };
    },
  },

  projections: {
    SUBJECT_FORGOTTEN: (aggregate, event) => ({
      ...aggregate,
      forgotten: true,
      forgottenAt: event.timestamp,
    }),
  },
};

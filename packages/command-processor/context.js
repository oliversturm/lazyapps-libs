export const initializeContext = (
  correlationConfig,
  { aggregateStore, eventStore, eventBus, aggregates },
  handleCommand,
  handleAdminCommand,
) =>
  Promise.all([aggregateStore(aggregates), eventStore()])
    .then(([aggregateStore, eventStore]) => {
      if (aggregateStore.setEventStoreRef && eventStore.getEventsForAggregate) {
        aggregateStore.setEventStoreRef(eventStore.getEventsForAggregate);
      }
      return {
        aggregates,
        aggregateStore,
        eventStore,
        handleCommand,
        handleAdminCommand,
        correlationConfig,
      };
    })
    .then((context) =>
      eventBus().then((eventBus) => ({ ...context, eventBus })),
    );

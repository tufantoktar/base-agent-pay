export function createInFlightActionGuard() {
  let inFlight = false;

  return {
    get inFlight() {
      return inFlight;
    },
    async run(action) {
      if (inFlight) {
        return { ignored: true };
      }

      inFlight = true;
      try {
        const value = await action();
        return { ignored: false, value };
      } finally {
        inFlight = false;
      }
    },
  };
}

export class PaymentAdapter {
  constructor({ mode } = {}) {
    this.mode = mode ?? "unknown";
  }

  createPaymentRequired() {
    throw new Error("PaymentAdapter.createPaymentRequired must be implemented");
  }

  verifyPayment() {
    throw new Error("PaymentAdapter.verifyPayment must be implemented");
  }

  getCachedTaskResponse() {
    return null;
  }

  storeCompletedTaskResponse() {}
}

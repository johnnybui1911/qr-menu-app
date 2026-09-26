// Pure transition guards for the order state machine (D9). SQL enforces the same rule with
// `UPDATE … WHERE status = <from>`; these guards decide which statement to build.

export type OrderStatus = 'pending_payment' | 'paid' | 'preparing' | 'fulfilled' | 'cancelled' | 'refunded';

export const markPaidEligible = (status: string): boolean => status === 'pending_payment';
export const startPreparingEligible = (status: string): boolean => status === 'paid';
export const fulfillEligible = (status: string): boolean => status === 'preparing';
export const cancelEligible = (status: string): boolean => status === 'pending_payment';
export const refundEligible = (status: string): boolean => status === 'paid' || status === 'preparing' || status === 'fulfilled';

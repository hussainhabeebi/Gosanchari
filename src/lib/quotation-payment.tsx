import { money } from './util'

export const BALANCE_STATEMENT = 'Balance amount to be paid at the hotel at check-in time.'
export function reportedAdvance(value: unknown, total: number): number {
  const text = String(value ?? 0).trim()
  const amount = text === '' ? 0 : Number(text)
  if (!/^\d*(?:\.0+)?$/.test(text) || !Number.isSafeInteger(amount) || amount < 0 || amount > total)
    throw new Error('Advance Received must be a non-negative whole-rupee amount no greater than Total Amount.')
  return amount
}
export function QuotationPayment({ total, advance = 0 }: { total: number; advance?: number }) {
  return <div class="small quotation-payment"><p>Total Amount: {money(total)} · Advance Received: {money(advance)} (reported, not verified) · <strong>Balance Payable: {money(total - advance)}</strong></p><p class="muted">Payment reported by staff; not verified by Admin. This quotation does not confirm a booking.</p></div>
}
export function quotationPaymentHtml(total: number, advance = 0) {
  return `<div class="quote-payment"><p>Total Amount: ${money(total)} · Advance Received: ${money(advance)} (reported, not verified) · <strong>Balance Payable: ${money(total - advance)}</strong></p><p>Payment reported by staff; not verified by Admin. This quotation does not confirm a booking.</p></div>`
}

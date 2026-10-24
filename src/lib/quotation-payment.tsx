import { isDate, money, parseJson, todayIST } from './util'

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
  return `<div class="quote-payment"><p>Total Amount: ${money(total)} · Advance Received: ${money(advance)} · <strong>Balance Payable: ${money(total - advance)}</strong></p></div>`
}

export interface AdvanceDetails { date: string; method: string; reference: string }
export const ADVANCE_METHODS = ['upi', 'bank_transfer', 'cash', 'card', 'other'] as const
export function advanceDetails(raw?: string): Partial<AdvanceDetails> {
  const value = parseJson<unknown>(raw ?? '{}', {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string,unknown>
  return { date: typeof record.date === 'string' ? record.date : '', method: typeof record.method === 'string' ? record.method : '', reference: typeof record.reference === 'string' ? record.reference : '' }
}
export function validateAdvanceDetails(date: string, method: string, reference: string): AdvanceDetails {
  if (!isDate(date) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date || date > todayIST()) throw new Error('Enter the actual payment date, not a future date.')
  if (!(ADVANCE_METHODS as readonly string[]).includes(method)) throw new Error('Choose a payment method.')
  if (reference.trim().length > 100) throw new Error('Transaction reference must be 100 characters or fewer.')
  return { date, method, reference: reference.trim() }
}

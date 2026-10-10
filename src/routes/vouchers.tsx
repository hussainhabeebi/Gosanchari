// Booking confirmation vouchers: staff request → admin approves (or sends back) → staff receive the approved
// "Booking Confirmed" voucher under My vouchers. The approved voucher is a frozen snapshot of the booking.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Pill, Table, Tabs } from '../views/components'
import { permissionsFor, requirePerm, requireStaff } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, notifyStaff, run } from '../lib/db'
import { voucherData, voucherHtml, type VoucherData } from '../lib/vouchers'
import { fmtDate, fmtDateTime, int, money, nowIso, parseJson, refCode, str } from '../lib/util'
import { form, redirectMsg } from './helpers'

export const voucherRoutes = new Hono<AppEnv>()

export interface VoucherRow {
  id: number
  code: string
  booking_id: number
  status: 'pending' | 'approved' | 'rejected'
  kids_ages: string
  staff_remarks: string
  admin_remarks: string
  reject_reason: string | null
  snapshot: string | null
  requested_by: number | null
  decided_by: number | null
  created_at: string
  decided_at: string | null
}

type ListRow = VoucherRow & { booking_code: string; guest_name: string; property_name: string; check_in: string; check_out: string; total: number; amount_paid: number; requester: string | null; decider: string | null }
const LIST_SQL = `SELECT v.*, b.code AS booking_code, b.guest_name, b.check_in, b.check_out, b.total, b.amount_paid, p.name AS property_name,
    ru.name AS requester, du.name AS decider
  FROM booking_vouchers v JOIN bookings b ON b.id = v.booking_id JOIN properties p ON p.id = b.property_id
  LEFT JOIN users ru ON ru.id = v.requested_by LEFT JOIN users du ON du.id = v.decided_by`

/** Who may open a voucher: the staff member who asked for it, approvers, and managers who see every enquiry. */
async function canView(c: Context<AppEnv>, v: VoucherRow) {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  return v.requested_by === u.id || perms.approve_vouchers || perms.view_all_enquiries
}

// ---------- Staff: request a voucher from a booking ----------
voucherRoutes.post('/staff/bookings/:id/voucher', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const id = int(c.req.param('id'))
  const b = await first<{ id: number; code: string; status: string; amount_paid: number; guest_name: string; children: number }>(c.env, 'SELECT id, code, status, amount_paid, guest_name, children FROM bookings WHERE id = ?', id)
  if (!b) return c.notFound()
  const back = `/staff/bookings/${b.id}`
  if (b.status === 'cancelled') return redirectMsg(c, back, { err: 'This booking is cancelled.' })
  if (b.amount_paid <= 0) return redirectMsg(c, back, { err: 'Record the guest’s advance payment first, then send the voucher for approval.' })
  if (await first(c.env, "SELECT 1 FROM booking_vouchers WHERE booking_id = ? AND status = 'pending'", b.id)) return redirectMsg(c, back, { err: 'A voucher for this booking is already waiting for admin approval.' })
  const f = await form(c)
  const kidsAges = str(f.kids_ages, 120)
  if (b.children > 0 && !kidsAges) return redirectMsg(c, back, { err: 'Enter the kids’ ages for the voucher.' })
  const code = refCode('VC')
  await insertId(c.env, 'INSERT INTO booking_vouchers (code, booking_id, kids_ages, staff_remarks, requested_by) VALUES (?, ?, ?, ?, ?)', code, b.id, kidsAges, str(f.remarks, 1000), u.id)
  await logActivity(c.env, u.id, 'voucher.requested', 'booking', b.id, { voucher: code })
  await notifyStaff(c.env, 'voucher_request', `Voucher ${code} for booking ${b.code} (${b.guest_name}) is waiting for approval: ${c.env.SITE_URL}/admin/vouchers`)
  return redirectMsg(c, back, { ok: `Voucher ${code} sent to admin for approval. The approved voucher will appear under My vouchers.` })
})

// ---------- Staff: my vouchers ----------
voucherRoutes.get('/staff/vouchers', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const rows = await all<ListRow>(c.env, `${LIST_SQL} WHERE v.requested_by = ? ORDER BY v.id DESC LIMIT 200`, u.id)
  return page(c, { title: 'My vouchers', area: 'staff', active: 'vouchers' }, (
    <div class="stack-lg">
      <h1>My vouchers</h1>
      <p class="muted">Booking confirmation vouchers you sent for approval. Approved vouchers open as “Booking Confirmed” — download the PDF and send it to the guest.</p>
      <VoucherTable rows={rows} />
      {rows.length === 0 && <Empty>No vouchers yet. Open a booking with an advance payment and use “Send voucher for approval”.</Empty>}
    </div>
  ))
})

const VoucherTable = ({ rows, admin }: { rows: ListRow[]; admin?: boolean }) => (
  <Table head={['Voucher', 'Booking', 'Guest', 'Resort', 'Stay', 'Paid / total', ...(admin ? ['Requested by'] : []), 'Status', '']}>
    {rows.map((v) => (
      <tr>
        <td><a href={`/vouchers/${v.id}`}>{v.code}</a><div class="muted small">{fmtDateTime(v.created_at)}</div></td>
        <td><a href={`/staff/bookings/${v.booking_id}`}>{v.booking_code}</a></td>
        <td>{v.guest_name}</td>
        <td>{v.property_name}</td>
        <td class="nowrap">{fmtDate(v.check_in)} → {fmtDate(v.check_out)}</td>
        <td class="nowrap">{money(v.amount_paid)} / {money(v.total)}</td>
        {admin && <td>{v.requester ?? '—'}</td>}
        <td><Pill s={v.status} />{v.status === 'rejected' && v.reject_reason && <div class="small error">{v.reject_reason}</div>}{v.status === 'approved' && v.decider && <div class="small muted">by {v.decider}</div>}</td>
        <td class="nowrap"><a class={`btn btn-sm ${v.status === 'approved' ? '' : 'btn-outline'}`} href={`/vouchers/${v.id}`}>{v.status === 'approved' ? 'Open voucher' : 'View'}</a></td>
      </tr>
    ))}
  </Table>
)

// ---------- Admin: approvals ----------
voucherRoutes.get('/admin/vouchers', requirePerm('approve_vouchers'), async (c) => {
  const tab = ['pending', 'approved', 'rejected'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'pending'
  const rows = await all<ListRow>(c.env, `${LIST_SQL} WHERE v.status = ? ORDER BY v.id ${tab === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`, tab)
  return page(c, { title: 'Voucher approvals', area: 'admin', active: 'voucher-approvals' }, (
    <div class="stack-lg">
      <h1>Booking voucher approvals</h1>
      <Tabs base="/admin/vouchers" param="status" active={tab} items={[['pending', 'Waiting for approval'], ['approved', 'Approved'], ['rejected', 'Sent back']]} />
      {tab === 'pending'
        ? rows.map((v) => (
          <section class="card stack voucher-approval">
            <div class="row-between">
              <div><strong>{v.code}</strong> · booking <a href={`/staff/bookings/${v.booking_id}`}>{v.booking_code}</a> · {v.guest_name}<div class="muted small">{v.property_name} · {fmtDate(v.check_in)} → {fmtDate(v.check_out)} · advance {money(v.amount_paid)} of {money(v.total)} · requested by {v.requester ?? '—'} {fmtDateTime(v.created_at)}</div></div>
              <a class="btn btn-sm btn-outline" href={`/vouchers/${v.id}`} target="_blank">Preview voucher</a>
            </div>
            {v.staff_remarks && <p class="small"><strong>Staff remarks:</strong> {v.staff_remarks}</p>}
            <div class="grid grid-2">
              <form method="post" action={`/admin/vouchers/${v.id}/approve`} class="stack">
                <Field label="Admin remarks (shown on the voucher)"><textarea name="admin_remarks" rows={2} maxlength={1000}></textarea></Field>
                <button class="btn btn-sm">Approve — issue “Booking Confirmed”</button>
              </form>
              <form method="post" action={`/admin/vouchers/${v.id}/reject`} class="stack">
                <Field label="Reason for sending back"><textarea name="reason" rows={2} maxlength={500} required></textarea></Field>
                <button class="btn btn-sm btn-outline">Send back to staff</button>
              </form>
            </div>
          </section>
        ))
        : <VoucherTable rows={rows} admin />}
      {rows.length === 0 && <Empty>{tab === 'pending' ? 'No vouchers are waiting for approval.' : 'Nothing here yet.'}</Empty>}
    </div>
  ))
})

async function pendingVoucher(c: Context<AppEnv>) {
  const v = await first<VoucherRow & { booking_code: string; guest_name: string }>(c.env, 'SELECT v.*, b.code AS booking_code, b.guest_name FROM booking_vouchers v JOIN bookings b ON b.id = v.booking_id WHERE v.id = ?', int(c.req.param('id')))
  return v && v.status === 'pending' ? v : null
}

/** Tell the staff member who asked, on WhatsApp, unless they switched voucher messages off. */
async function tellRequester(c: Context<AppEnv>, userId: number | null, text: string) {
  if (!userId) return
  const u = await first<{ phone: string | null; notify_settings: string }>(c.env, 'SELECT phone, notify_settings FROM users WHERE id = ? AND active = 1', userId)
  if (u?.phone && parseJson<Record<string, boolean>>(u.notify_settings, {}).voucher_request !== false) await enqueue(c.env, { type: 'whatsapp', to: u.phone, text })
}

voucherRoutes.post('/admin/vouchers/:id/approve', requirePerm('approve_vouchers'), async (c) => {
  const u = c.get('user')!
  const v = await pendingVoucher(c)
  if (!v) return redirectMsg(c, '/admin/vouchers', { err: 'This voucher is no longer waiting for approval.' })
  const b = await first<{ status: string; amount_paid: number }>(c.env, 'SELECT status, amount_paid FROM bookings WHERE id = ?', v.booking_id)
  if (!b || b.status === 'cancelled') return redirectMsg(c, '/admin/vouchers', { err: `Booking ${v.booking_code} is cancelled — send the voucher back instead.` })
  const f = await form(c)
  const adminRemarks = str(f.admin_remarks, 1000)
  const data = await voucherData(c.env, v.booking_id, { kids_ages: v.kids_ages, staff_remarks: v.staff_remarks, admin_remarks: adminRemarks })
  if (!data) return redirectMsg(c, '/admin/vouchers', { err: 'Booking not found.' })
  // Only one decision wins if two admins click at the same time.
  await run(c.env, "UPDATE booking_vouchers SET status = 'approved', admin_remarks = ?, snapshot = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", adminRemarks, JSON.stringify(data), u.id, nowIso(), v.id)
  await logActivity(c.env, u.id, 'voucher.approved', 'booking', v.booking_id, { voucher: v.code })
  await tellRequester(c, v.requested_by, `Voucher ${v.code} for ${v.guest_name} (booking ${v.booking_code}) is approved — Booking Confirmed. Open it: ${c.env.SITE_URL}/vouchers/${v.id}`)
  return redirectMsg(c, '/admin/vouchers', { ok: `Voucher ${v.code} approved. ${v.guest_name}’s booking is confirmed and the voucher is in the staff member’s My vouchers.` })
})

voucherRoutes.post('/admin/vouchers/:id/reject', requirePerm('approve_vouchers'), async (c) => {
  const u = c.get('user')!
  const v = await pendingVoucher(c)
  if (!v) return redirectMsg(c, '/admin/vouchers', { err: 'This voucher is no longer waiting for approval.' })
  const f = await form(c)
  const reason = str(f.reason, 500)
  if (!reason) return redirectMsg(c, '/admin/vouchers', { err: 'Give a reason so the staff member knows what to fix.' })
  await run(c.env, "UPDATE booking_vouchers SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", reason, u.id, nowIso(), v.id)
  await logActivity(c.env, u.id, 'voucher.rejected', 'booking', v.booking_id, { voucher: v.code, reason })
  await tellRequester(c, v.requested_by, `Voucher ${v.code} for ${v.guest_name} (booking ${v.booking_code}) was sent back: ${reason}`)
  return redirectMsg(c, '/admin/vouchers', { ok: `Voucher ${v.code} sent back to staff.` })
})

// ---------- The voucher itself ----------
voucherRoutes.get('/vouchers/:id', requireStaff, async (c) => {
  const v = await first<VoucherRow>(c.env, 'SELECT * FROM booking_vouchers WHERE id = ?', int(c.req.param('id')))
  if (!v || !(await canView(c, v))) return c.notFound()
  c.header('Cache-Control', 'private, no-store')
  if (v.status === 'approved' && v.snapshot) return c.html(voucherHtml(parseJson<VoucherData>(v.snapshot, {} as VoucherData), { code: v.code, issued: v.decided_at }))
  const data = await voucherData(c.env, v.booking_id, { kids_ages: v.kids_ages, staff_remarks: v.staff_remarks, admin_remarks: v.admin_remarks })
  if (!data) return c.notFound()
  const banner = v.status === 'rejected'
    ? `NOT VALID — sent back by admin${v.reject_reason ? `: ${v.reject_reason}` : ''}. Do not share with the guest.`
    : 'PREVIEW — waiting for admin approval. Not valid until approved; do not share with the guest.'
  return c.html(voucherHtml(data, { code: v.code, issued: null, draft: banner }))
})

/** Latest voucher of a booking, for the booking page. */
export async function latestVoucher(env: AppEnv['Bindings'], bookingId: number) {
  return first<VoucherRow & { decider: string | null }>(env, 'SELECT v.*, u.name AS decider FROM booking_vouchers v LEFT JOIN users u ON u.id = v.decided_by WHERE v.booking_id = ? ORDER BY v.id DESC LIMIT 1', bookingId)
}

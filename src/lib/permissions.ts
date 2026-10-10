// Roles and permissions. Defaults live here; admins can override them from Staff & roles
// (stored in settings under "role_permissions").

export type Role = 'guest' | 'admin' | 'manager' | 'sales' | 'accounts'
export const STAFF_ROLES: Role[] = ['admin', 'manager', 'sales', 'accounts']

export interface Permissions {
  view_net_rates: boolean
  max_discount_pct: number
  view_all_enquiries: boolean
  manage_enquiries: boolean
  manage_quotes: boolean
  approve_discounts: boolean
  manage_bookings: boolean
  approve_cancellations: boolean
  approve_vouchers: boolean
  manage_properties: boolean
  view_property_contacts: boolean
  manage_rates: boolean
  manage_offers: boolean
  manage_payments: boolean
  approve_refunds: boolean
  manage_guests: boolean
  manage_reviews: boolean
  manage_content: boolean
  manage_staff: boolean
  manage_settings: boolean
  view_reports: boolean
  export_data: boolean
  ask_ai: boolean
  view_activity: boolean
}

export type PermissionKey = keyof Permissions

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  view_net_rates: 'See B2B / net rates, margins and commission (management only)',
  max_discount_pct: 'Maximum discount on a quote (%)',
  view_all_enquiries: 'See every enquiry (not only their own)',
  manage_enquiries: 'Work on enquiries',
  manage_quotes: 'Create and send quotations',
  approve_discounts: 'Approve discounts above the staff limit',
  manage_bookings: 'Manage bookings',
  approve_cancellations: 'Approve cancellations and date changes',
  approve_vouchers: 'Approve booking confirmation vouchers',
  manage_properties: 'Add and edit properties',
  view_property_contacts: 'See and edit property contact details (contact person, numbers, email, account details)',
  manage_rates: 'Change rates and availability',
  manage_offers: 'Manage offers and coupons',
  manage_payments: 'See payments and payouts',
  approve_refunds: 'Approve refunds',
  manage_guests: 'Export, merge and block guests',
  manage_reviews: 'Moderate reviews',
  manage_content: 'Edit website content',
  manage_staff: 'Manage staff and roles',
  manage_settings: 'Change settings',
  view_reports: 'See reports and admin dashboard',
  export_data: 'Export data',
  ask_ai: 'Use Ask AI (business questions)',
  view_activity: 'See the activity log',
}

const none: Permissions = {
  view_net_rates: false,
  max_discount_pct: 0,
  view_all_enquiries: false,
  manage_enquiries: false,
  manage_quotes: false,
  approve_discounts: false,
  manage_bookings: false,
  approve_cancellations: false,
  approve_vouchers: false,
  manage_properties: false,
  view_property_contacts: false,
  manage_rates: false,
  manage_offers: false,
  manage_payments: false,
  approve_refunds: false,
  manage_guests: false,
  manage_reviews: false,
  manage_content: false,
  manage_staff: false,
  manage_settings: false,
  view_reports: false,
  export_data: false,
  ask_ai: false,
  view_activity: false,
}

export const DEFAULT_PERMISSIONS: Record<Role, Permissions> = {
  guest: none,
  admin: Object.fromEntries(Object.keys(none).map((k) => [k, k === 'max_discount_pct' ? 100 : true])) as unknown as Permissions,
  manager: {
    ...none,
    view_net_rates: true,
    max_discount_pct: 15,
    view_all_enquiries: true,
    manage_enquiries: true,
    manage_quotes: true,
    approve_discounts: true,
    manage_bookings: true,
    approve_cancellations: true,
    manage_properties: true,
    manage_rates: true,
    manage_offers: true,
    manage_guests: true,
    manage_reviews: true,
    manage_content: true,
    view_reports: true,
    export_data: true,
    ask_ai: true,
    view_activity: true,
  },
  sales: {
    ...none,
    max_discount_pct: 5,
    manage_enquiries: true,
    manage_quotes: true,
    manage_bookings: true,
  },
  accounts: {
    ...none,
    view_net_rates: true,
    manage_bookings: true,
    manage_payments: true,
    approve_refunds: true,
    view_reports: true,
    export_data: true,
  },
}

export function isStaff(role: Role | undefined | null): boolean {
  return !!role && role !== 'guest'
}

/** Merge admin overrides over the defaults. Admin always keeps every permission. */
export function resolvePermissions(role: Role, overrides?: Partial<Record<Role, Partial<Permissions>>>): Permissions {
  if (role === 'admin') return DEFAULT_PERMISSIONS.admin
  return { ...DEFAULT_PERMISSIONS[role], ...(overrides?.[role] ?? {}) }
}

export const ROLE_LABELS: Record<Role, string> = {
  guest: 'Guest',
  admin: 'Admin',
  manager: 'Manager',
  sales: 'Sales staff',
  accounts: 'Accounts',
}

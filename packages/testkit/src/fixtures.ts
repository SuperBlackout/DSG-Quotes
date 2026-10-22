import type { ZohoContact, ZohoInvoice, ZohoPayment, ZohoCreditNote, ZohoSalesOrder } from '@dsg/contracts';

export const DEALER_A = { companyId: 'gid://shopify/Company/1', zohoId: 'Z-1048', number: 'CUS-1048', name: 'Pure Vision' };
export const DEALER_B = { companyId: 'gid://shopify/Company/2', zohoId: 'Z-1626', number: 'CUS-1626', name: 'Digital Sales Group Metro LLC' };

export const contacts: ZohoContact[] = [
  { contact_id: DEALER_A.zohoId, contact_name: DEALER_A.name, customer_number: DEALER_A.number, currency_code: 'USD', payment_terms_label: 'Net 30', credit_limit: 10000, outstanding_receivable_amount: 1250.5, unused_credits_receivable_amount: 100 },
  { contact_id: DEALER_B.zohoId, contact_name: DEALER_B.name, customer_number: DEALER_B.number, currency_code: 'USD', payment_terms_label: 'Net 15', credit_limit: 5000, outstanding_receivable_amount: 300, unused_credits_receivable_amount: 0 },
];
export const invoices: ZohoInvoice[] = [
  { invoice_id: 'I-1', customer_id: DEALER_A.zohoId, invoice_number: 'INV-0001', date: '2026-09-01', due_date: '2026-10-01', status: 'overdue', total: 800.5, balance: 800.5, currency_code: 'USD', reference_number: 'PO-77' },
  { invoice_id: 'I-2', customer_id: DEALER_A.zohoId, invoice_number: 'INV-0002', date: '2026-10-10', due_date: '2026-11-09', status: 'sent', total: 450, balance: 450, currency_code: 'USD', reference_number: '' },
  { invoice_id: 'I-3', customer_id: DEALER_B.zohoId, invoice_number: 'INV-0003', date: '2026-10-05', due_date: '2026-10-20', status: 'sent', total: 300, balance: 300, currency_code: 'USD', reference_number: '' },
];
export const payments: ZohoPayment[] = [
  { payment_id: 'P-1', customer_id: DEALER_A.zohoId, payment_number: '1', date: '2026-09-15', amount: 500, unused_amount: 100, currency_code: 'USD', reference_number: 'CHK 4410' },
];
export const creditNotes: ZohoCreditNote[] = [];
export const salesOrders: ZohoSalesOrder[] = [
  { salesorder_id: 'S-1', customer_id: DEALER_A.zohoId, salesorder_number: 'SO-0001', date: '2026-10-18', status: 'open', total: 1200, currency_code: 'USD', reference_number: 'phone order' },
];

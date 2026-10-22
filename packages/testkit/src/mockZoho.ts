import type { ZohoReader } from '@dsg/contracts';
import * as f from './fixtures.js';

/** In-memory ZohoReader for tests. Counts calls so tests can assert API budget behaviour. */
export class FakeZoho implements ZohoReader {
  calls = 0;
  contacts = [...f.contacts]; invoices = [...f.invoices]; payments = [...f.payments];
  creditNotes = [...f.creditNotes]; salesOrders = [...f.salesOrders];
  failNext = 0;
  private tick() { this.calls++; if (this.failNext > 0) { this.failNext--; throw new Error('zoho unavailable'); } }
  async getContact(id: string) { this.tick(); const c = this.contacts.find(c => c.contact_id === id); if (!c) throw new Error('not found'); return c; }
  async findContactByCustomerNumber(n: string) { this.tick(); return this.contacts.find(c => c.customer_number === n) ?? null; }
  async listInvoices(id: string) { this.tick(); return this.invoices.filter(i => i.customer_id === id); }
  async listPayments(id: string) { this.tick(); return this.payments.filter(i => i.customer_id === id); }
  async listCreditNotes(id: string) { this.tick(); return this.creditNotes.filter(i => i.customer_id === id); }
  async listSalesOrders(id: string) { this.tick(); return this.salesOrders.filter(i => i.customer_id === id); }
  async getInvoicePdf(id: string) { this.tick(); return new TextEncoder().encode(`%PDF-fake invoice ${id}`); }
  async getStatementPdf(id: string, from: string, to: string) { this.tick(); return new TextEncoder().encode(`%PDF-fake statement ${id} ${from} ${to}`); }
}

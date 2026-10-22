create table account_map (
  shopify_company_id text primary key,
  zoho_customer_id   text not null unique,
  customer_number    text not null unique,
  display_name       text not null,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create table zoho_contact (
  zoho_customer_id text primary key,
  customer_number text not null,
  name text not null,
  currency_code text not null default 'USD',
  payment_terms_label text,
  credit_limit numeric(14,2),
  outstanding_receivable numeric(14,2) not null default 0,
  unused_credits numeric(14,2) not null default 0,
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now()
);
create table zoho_document (
  id text primary key,
  zoho_customer_id text not null,
  kind text not null check (kind in ('invoice','payment','credit_note','sales_order')),
  number text not null,
  doc_date date not null,
  due_date date,
  status text not null,
  total numeric(14,2) not null,
  balance numeric(14,2) not null default 0,
  currency_code text not null default 'USD',
  reference text,
  source text not null default 'zoho' check (source in ('zoho','shopify')),
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now()
);
create index zoho_document_zoho_customer_id_doc_date_idx on zoho_document (zoho_customer_id, doc_date desc);
create table pdf_link (
  token_hash text primary key,
  zoho_customer_id text not null,
  doc_kind text not null,
  doc_id text,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table sync_event (
  id bigserial primary key,
  zoho_customer_id text,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table access_audit (
  id bigserial primary key,
  shopify_company_id text,
  zoho_customer_id text,
  action text not null,
  outcome text not null,
  created_at timestamptz not null default now()
);

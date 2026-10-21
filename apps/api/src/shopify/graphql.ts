/**
 * Every Admin GraphQL operation the API sends. `pnpm -F api graphql:validate` validates ALL documents in
 * `DOCUMENTS` against the schema file named by SHOPIFY_SCHEMA_PATH (CLAUDE.md rule 7).
 *
 * STATUS: written from the public docs for ADMIN_API_VERSION, NOT yet validated against the real schema
 * (no schema file / Shopify access was available when this was written). Run the validator before use.
 */

export const BUYER_BY_CUSTOMER = /* GraphQL */ `
  query BuyerByCustomer($id: ID!) {
    shop {
      currencyCode
    }
    customer(id: $id) {
      id
      displayName
      defaultEmailAddress {
        emailAddress
      }
      companyContactProfiles {
        id
        company {
          id
          name
        }
        roleAssignments(first: 25) {
          nodes {
            companyLocation {
              id
              name
              buyerExperienceConfiguration {
                paymentTermsTemplate {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const VARIANT_PRICING = /* GraphQL */ `
  query VariantPricing($id: ID!, $companyLocationId: ID!) {
    productVariant(id: $id) {
      id
      sku
      title
      displayName
      image {
        url
      }
      product {
        title
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
      }
      contextualPricing(context: { companyLocationId: $companyLocationId }) {
        price {
          amount
          currencyCode
        }
      }
      inventoryItem {
        unitCost {
          amount
        }
      }
    }
  }
`;

export const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const DRAFT_ORDER_COMPLETE = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        order {
          id
          statusPageUrl
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const DRAFT_ORDER_DELETE = /* GraphQL */ `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }
`;

export const DOCUMENTS: Record<string, string> = {
  BUYER_BY_CUSTOMER,
  VARIANT_PRICING,
  DRAFT_ORDER_CREATE,
  DRAFT_ORDER_COMPLETE,
  DRAFT_ORDER_DELETE,
};

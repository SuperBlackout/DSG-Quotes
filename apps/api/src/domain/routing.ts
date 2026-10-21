import type { AppDeps, Tx } from "../context";

/**
 * Applied when a quote is SUBMITTED (by the customer or by staff on their behalf), inside the same transaction.
 *  - `ShopSetting.autoAssignByCompany` on: the first RoutingRule for the quote's company assigns its rep and/or team.
 *  - Quotes no rule matches go to `ShopSetting.defaultTeamId` (when set), whatever the toggle says.
 * Never overrides an owner or team that is already set, never writes an event (the SUBMIT event already notifies sales;
 * recipients are resolved from the quote when the worker fans it out).
 */
export async function applyRouting(tx: Tx, deps: AppDeps, quoteId: string): Promise<void> {
  const shop = deps.config.shopDomain;
  const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const settings = await tx.shopSetting.findUnique({ where: { shop } });
  const rule =
    settings?.autoAssignByCompany && quote.companyId
      ? await tx.routingRule.findFirst({ where: { shop, companyId: quote.companyId }, orderBy: [{ position: "asc" }, { id: "asc" }] })
      : null;

  const rep = !quote.assignedRepId && rule?.repId ? await tx.staff.findFirst({ where: { id: rule.repId, shop, active: true } }) : null;
  const teamId = quote.teamId ? null : (rule?.teamId ?? settings?.defaultTeamId ?? null);
  if (!rep && !teamId) return;
  await tx.quote.update({ where: { id: quoteId }, data: { ...(rep ? { assignedRepId: rep.id } : {}), ...(teamId ? { teamId } : {}) } });
}

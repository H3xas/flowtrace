using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Greenhouse.Alerts.Filters
{
    public class RelayCheckFilter : IAsyncAuthorizationFilter
    {
        // The ledger is declared in another service, so the walk can only follow it through
        // the code index.
        private readonly RelayLedger _ledger;

        public RelayCheckFilter(RelayLedger ledger)
        {
            _ledger = ledger;
        }

        public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
        {
            var allowed = await _ledger.Allows(context.HttpContext.User);
            if (!allowed)
            {
                context.Result = new ForbidResult();
            }
        }
    }
}

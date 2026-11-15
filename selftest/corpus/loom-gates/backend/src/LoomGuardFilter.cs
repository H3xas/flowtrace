using System.Linq;
using System.Threading.Tasks;
using Loom.Gates.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Loom.Gates.Filters
{
    public class LoomGuardFilter : IAsyncAuthorizationFilter
    {
        private readonly IShuttleAudit _audit;

        public LoomGuardFilter(IShuttleAudit audit)
        {
            _audit = audit;
        }

        public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
        {
            var open = context.ActionDescriptor.FilterDescriptors.Any(f => f.Filter.GetType() == typeof(OpenLoomAttribute));
            if (open) return;

            await _audit.Record(context.HttpContext.TraceIdentifier);
            if (!context.HttpContext.User.Identity.IsAuthenticated)
            {
                context.Result = new UnauthorizedResult();
            }
        }
    }

    public class OpenLoomAttribute : System.Attribute
    {
    }
}

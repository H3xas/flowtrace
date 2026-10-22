using System.Linq;
using System.Threading.Tasks;
using Bakery.Gates.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Bakery.Gates.Filters
{
    public class KitchenAccessFilter : IAsyncAuthorizationFilter
    {
        private readonly IKitchenToggles _toggles;

        public KitchenAccessFilter(IKitchenToggles toggles)
        {
            _toggles = toggles;
        }

        public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
        {
            var open = context.ActionDescriptor.FilterDescriptors.Any(f => f.Filter.GetType() == typeof(OpenKitchenAttribute));
            if (open) return;

            if (!context.HttpContext.User.Identity.IsAuthenticated)
            {
                context.Result = new StatusCodeResult(StatusCodes.Status401Unauthorized);
                return;
            }

            if (_toggles.IsToggleEnabled(Toggles.StrictKitchen))
            {
                if (!context.HttpContext.User.IsInRole("baker"))
                {
                    context.Result = new ForbidResult();
                }
            }

            await Task.CompletedTask;
        }
    }

    public class OpenKitchenAttribute : System.Attribute
    {
    }
}

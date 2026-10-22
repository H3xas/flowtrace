using Bakery.Gates.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Bakery.Gates.Filters
{
    public class OvenFaultFilter : ExceptionFilterAttribute
    {
        public override void OnException(ExceptionContext context)
        {
            if (context.Exception is OvenFaultException)
            {
                context.Result = new StatusCodeResult(StatusCodes.Status503ServiceUnavailable);
            }
        }
    }
}
